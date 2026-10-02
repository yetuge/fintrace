import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import {
  deleteMainConversation,
  getJidsByFolder,
  getLatestMessagePreviewPerChat,
  getRegisteredGroup,
  getRouterState,
  getSession,
  getGroupsByTargetMainJid,
  getGroupsByTargetAgent,
  listChannelMountsBySession,
  listImContextBindingsByAgent,
  listChannelMountsByWorkspace,
  peekAgentProfileForWorkspace,
} from './db.js';
import type { RegisteredGroup } from './types.js';
import type { WebDeps } from './web-context.js';
import { logger } from './logger.js';

export class SessionDeletionConflict extends Error {
  constructor(
    message: string,
    readonly bindings?: Array<{ jid: string; name: string }>,
  ) {
    super(message);
  }
}

const deletingSessions = new Set<string>();
const deletionVersions = new Map<string, number>();
const deletionKey = (jid: string, sessionId: string) =>
  JSON.stringify([jid, sessionId]);

export function getSessionDeletionVersion(jid: string, sessionId: string) {
  return deletionVersions.get(deletionKey(jid, sessionId)) ?? 0;
}

/** Also reject a metadata lookup that crossed a completed deletion attempt. */
export function isSessionBindingBlocked(
  jid: string,
  sessionId: string,
  version: number,
) {
  return (
    deletingSessions.has(deletionKey(jid, sessionId)) ||
    getSessionDeletionVersion(jid, sessionId) !== version
  );
}

/** The final validation and file/DB commit are synchronous after quiescing. */
export async function quiesceSessionForDeletion(
  jid: string,
  sessionId: string,
  deps: WebDeps,
  commit: () => void,
) {
  const key = deletionKey(jid, sessionId);
  if (deletingSessions.has(key))
    throw new SessionDeletionConflict(
      'Session deletion is already in progress',
    );
  deletingSessions.add(key);
  deletionVersions.set(key, getSessionDeletionVersion(jid, sessionId) + 1);
  try {
    const virtualJid = sessionId === 'main' ? jid : `${jid}#agent:${sessionId}`;
    const token = deps.queue.pauseGroupsForMutation([virtualJid]);
    try {
      await deps.queue.stopGroup(virtualJid, { force: true });
      commit();
    } finally {
      deps.queue.resumeGroupsAfterMutation(token);
    }
  } finally {
    deletingSessions.delete(key);
  }
}

/** Stage validated context roots/children; restore them if the DB commit fails. */
export function deleteSessionFilesTransactionally(
  sources: string[],
  commit: () => void,
) {
  const archiveDir = path.resolve(
    DATA_DIR,
    '.session-deletion',
    crypto.randomUUID(),
  );
  // Checking parents allows moving a leaf symlink without following its target.
  assertSessionDeletionPathsSafe([
    ...sources.map((p) => path.dirname(p)),
    archiveDir,
  ]);
  const moved: Array<{ source: string; backup: string }> = [];
  let committed = false;
  let restored = false;
  try {
    for (const [index, source] of sources.entries()) {
      if (
        !fs.existsSync(source) &&
        !fs.lstatSync(source, { throwIfNoEntry: false })
      )
        continue;
      const backup = path.join(archiveDir, String(index));
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.renameSync(source, backup);
      moved.push({ source, backup });
    }
    commit();
    committed = true;
  } catch (error) {
    for (const { source, backup } of moved.reverse())
      fs.renameSync(backup, source);
    restored = true;
    throw error;
  } finally {
    if ((committed || restored) && fs.existsSync(archiveDir)) {
      try {
        fs.rmSync(archiveDir, { recursive: true, force: true });
      } catch {
        logger.warn('Session deletion staging cleanup failed');
      }
    }
  }
}

export function getMainSessionSummary(jid: string, group: RegisteredGroup) {
  const latest = getLatestMessagePreviewPerChat([jid]).get(jid);
  if (!latest && !getSession(group.folder)) return undefined;
  const profileName = group.is_home
    ? peekAgentProfileForWorkspace(group.folder, group.created_by)?.name
    : group.name;
  const displayName =
    !profileName || profileName === 'Default Agent' ? 'FinTrace' : profileName;
  return {
    name:
      getRouterState(`main-session-name:${group.folder}`) ||
      `${displayName} 对话`,
    created_at: group.added_at,
    last_active_at: latest?.timestamp || group.added_at,
    latest_message: latest
      ? { content: latest.content, timestamp: latest.timestamp }
      : null,
    linked_im_groups: getMainSessionBindings(jid, group),
  };
}

// A channel using the default context must be detached before deleting it.
// Session-specific channels keep their independent contexts and are unaffected.
export function getMainSessionBindings(jid: string, group: RegisteredGroup) {
  return [
    ...new Set([
      ...getJidsByFolder(group.folder),
      ...getGroupsByTargetMainJid(jid).map((item) => item.jid),
      ...listChannelMountsByWorkspace(jid)
        .filter(
          (mount) =>
            !mount.session_id && mount.routing_mode === 'single_session',
        )
        .map((mount) => mount.channel_jid),
    ]),
  ]
    .filter((candidate) => {
      if (candidate === jid) return false;
      const related = getRegisteredGroup(candidate);
      return (
        related &&
        !related.target_agent_id &&
        related.conversation_nav_mode !== 'vertical_threads'
      );
    })
    .map((candidate) => ({
      jid: candidate,
      name: getRegisteredGroup(candidate)!.name,
    }));
}

export function getConversationSessionBindings(sessionId: string) {
  const jids = new Set([
    ...getGroupsByTargetAgent(sessionId).map((item) => item.jid),
    ...listChannelMountsBySession(sessionId).map((mount) => mount.channel_jid),
    ...listImContextBindingsByAgent(sessionId).map(
      (binding) => binding.source_jid,
    ),
  ]);
  return [...jids].map((jid) => ({
    jid,
    name: getRegisteredGroup(jid)?.name ?? jid,
  }));
}

/** Reject computed paths and links escaping FinTrace's runtime data directory. */
export function assertSessionDeletionPathsSafe(targets: string[]) {
  const dataRoot = fs.realpathSync(DATA_DIR);
  const inside = (target: string) =>
    target.startsWith(`${dataRoot}${path.sep}`);
  for (const target of targets) {
    if (!inside(target)) throw new Error('Unsafe session path');
    let ancestor = target;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    if (ancestor !== dataRoot && !inside(fs.realpathSync(ancestor)))
      throw new Error('Unsafe session link');
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())
      throw new Error('Unsafe session link');
  }
}

/** Quiesce the default runner, then stage its files for rollback before DB commit. */
export async function deleteMainSession(
  jid: string,
  group: RegisteredGroup,
  deps: WebDeps,
) {
  if (
    !group.folder ||
    group.folder === '.' ||
    group.folder === '..' ||
    /[/\\]/.test(group.folder)
  )
    throw new Error('Unsafe session folder');
  const claudeDir = path.resolve(DATA_DIR, 'sessions', group.folder, '.claude');
  const inputDir = path.resolve(DATA_DIR, 'ipc', group.folder, 'input');
  // Validate every computed absolute target before moving or recursively deleting.
  assertSessionDeletionPathsSafe([claudeDir, inputDir]);
  await quiesceSessionForDeletion(jid, 'main', deps, () => {
    const freshGroup = getRegisteredGroup(jid);
    if (
      !freshGroup ||
      freshGroup.folder !== group.folder ||
      freshGroup.created_by !== group.created_by
    )
      throw new SessionDeletionConflict(
        'Workspace changed during deletion; retry',
      );
    const bindings = getMainSessionBindings(jid, freshGroup);
    if (bindings.length)
      throw new SessionDeletionConflict(
        'Session has active channel bindings. Unbind before deleting.',
        bindings,
      );
    assertSessionDeletionPathsSafe([claudeDir, inputDir]);
    const sources = fs.existsSync(claudeDir)
      ? fs
          .readdirSync(claudeDir)
          .filter((entry) => entry !== 'settings.json')
          .map((entry) => path.join(claudeDir, entry))
      : [];
    sources.push(inputDir);
    deleteSessionFilesTransactionally(sources, () =>
      deleteMainConversation(group.folder, jid),
    );
    try {
      delete deps.getSessions()[group.folder];
      deps.setLastAgentTimestamp(jid, { timestamp: '', id: '' });
    } catch {
      logger.warn({ jid }, 'Session deleted; runtime cache refresh failed');
    }
  });
  return { success: true as const };
}
