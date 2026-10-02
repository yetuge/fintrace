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
  listChannelMountsByWorkspace,
  peekAgentProfileForWorkspace,
} from './db.js';
import type { RegisteredGroup } from './types.js';
import type { WebDeps } from './web-context.js';
import { logger } from './logger.js';

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
  const archiveDir = path.resolve(
    DATA_DIR,
    '.session-deletion',
    crypto.randomUUID(),
  );
  // Validate every computed absolute target before moving or recursively deleting.
  assertSessionDeletionPathsSafe([claudeDir, inputDir, archiveDir]);
  const token = deps.queue.pauseGroupsForMutation([jid]);
  const moved: Array<{ source: string; backup: string }> = [];
  let committed = false;
  try {
    await deps.queue.stopGroup(jid, { force: true });
    const stage = (source: string, backup: string) => {
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.renameSync(source, backup);
      moved.push({ source, backup });
    };
    if (fs.existsSync(claudeDir)) {
      for (const entry of fs.readdirSync(claudeDir)) {
        if (entry === 'settings.json') continue;
        stage(
          path.join(claudeDir, entry),
          path.join(archiveDir, '.claude', entry),
        );
      }
    }
    if (fs.existsSync(inputDir))
      stage(inputDir, path.join(archiveDir, 'input'));
    deleteMainConversation(group.folder, jid);
    committed = true;
    try {
      delete deps.getSessions()[group.folder];
      deps.setLastAgentTimestamp(jid, { timestamp: '', id: '' });
    } catch {
      logger.warn({ jid }, 'Session deleted; runtime cache refresh failed');
    }
    return { success: true as const };
  } catch (error) {
    if (!committed) {
      for (const { source, backup } of moved.reverse())
        fs.renameSync(backup, source);
    }
    throw error;
  } finally {
    // Workspace files, memory and agents/{id} are never staged or removed.
    if (committed && fs.existsSync(archiveDir)) {
      try {
        fs.rmSync(archiveDir, { recursive: true, force: true });
      } catch {
        logger.warn({ jid }, 'Session deleted; staged backup cleanup failed');
      }
    }
    deps.queue.resumeGroupsAfterMutation(token);
  }
}
