import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fintrace-main-session-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
let userId = 'owner',
  role = 'admin';
vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { id: userId, username: userId, role, permissions: [] });
    return next();
  },
}));
vi.mock('../src/web.js', () => ({
  broadcastAgentStatus: vi.fn(),
  broadcastAgentRemoved: vi.fn(),
}));
const db = await import('../src/db.js');
const context = await import('../src/web-context.js');
const routes = (await import('../src/routes/agents.js')).default;
const service = await import('../src/main-session.js');
const jid = 'web:session-test',
  folder = 'session-test';
const stop = vi.fn(async () => {}),
  pause = vi.fn(() => ({ id: 1 })),
  resume = vi.fn();
const cache: Record<string, string> = {};
const mainFile = path.join(
  root,
  'sessions',
  folder,
  '.claude',
  'sessions',
  'old.jsonl',
);
const settings = path.join(
  root,
  'sessions',
  folder,
  '.claude',
  'settings.json',
);
const input = path.join(root, 'ipc', folder, 'input');
const report = path.join(root, 'groups', folder, 'report.md');
const sibling = path.join(
  root,
  'sessions',
  folder,
  'agents',
  'other',
  '.claude',
  'session.jsonl',
);
function write(p: string, value: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, value);
}
beforeAll(() => {
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  db.initDatabase();
});
beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  userId = 'owner';
  role = 'admin';
  stop.mockResolvedValue(undefined);
  for (const groupJid of Object.keys(db.getAllRegisteredGroups()))
    db.deleteRegisteredGroup(groupJid);
  db.deleteMessagesForChatJid(jid);
  db.deleteSession(folder);
  db.deleteRouterState(`main-session-name:${folder}`);
  db.setRegisteredGroup(jid, {
    name: '研究工作区',
    folder,
    added_at: '2026-10-01T00:00:00Z',
    executionMode: 'host',
    created_by: 'owner',
  });
  db.setSession(folder, 'old-main');
  db.setSession(folder, 'other-session', 'other');
  db.ensureChatExists(jid);
  db.storeMessageDirect(
    'old-message',
    jid,
    'owner',
    'Owner',
    'old main contents',
    '2026-10-01T01:00:00Z',
    false,
  );
  cache[folder] = 'old-main';
  write(mainFile, 'original model history');
  write(settings, '{}');
  write(path.join(input, 'queued.json'), 'old input');
  write(report, 'saved report');
  write(sibling, 'independent history');
  context.setWebDeps({
    queue: {
      stopGroup: stop,
      pauseGroupsForMutation: pause,
      resumeGroupsAfterMutation: resume,
    },
    getSessions: () => cache,
    getRegisteredGroups: () => ({}),
    setLastAgentTimestamp: vi.fn(),
  } as unknown as Parameters<typeof context.setWebDeps>[0]);
});
afterAll(() => {
  db.closeDatabase();
  const target = fs.realpathSync(root);
  if (!target.startsWith(`${fs.realpathSync(os.tmpdir())}${path.sep}`))
    throw new Error('Unsafe cleanup');
  fs.rmSync(target, { recursive: true, force: true });
});
async function request(
  method: string,
  suffix = '/sessions/main',
  body?: unknown,
) {
  return routes.request(`/${encodeURIComponent(jid)}${suffix}`, {
    method,
    ...(body
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
}
test('legacy conversation can be renamed independently of workspace and survives reload', async () => {
  const response = await request('PATCH', '/sessions/main', {
    name: '财务草稿',
  });
  expect(response.status).toBe(200);
  expect(db.getRegisteredGroup(jid)!.name).toBe('研究工作区');
  const listing = await (await request('GET', '/sessions')).json();
  expect(listing.sessions.find((s: any) => s.id === 'main').name).toBe(
    '财务草稿',
  );
});
test('delete stops only default runner and clears only default history, preserving files, settings and independent contexts', async () => {
  const response = await request('DELETE');
  expect(response.status).toBe(200);
  expect(pause).toHaveBeenCalledExactlyOnceWith([jid]);
  expect(stop).toHaveBeenCalledExactlyOnceWith(jid, { force: true });
  expect(resume).toHaveBeenCalledTimes(1);
  expect(db.getMessage(jid, 'old-message')).toBeNull();
  expect(db.getSession(folder)).toBeUndefined();
  expect(cache[folder]).toBeUndefined();
  expect(db.getSession(folder, 'other')).toBe('other-session');
  expect(fs.existsSync(mainFile)).toBe(false);
  expect(fs.existsSync(input)).toBe(false);
  expect(fs.readFileSync(report, 'utf8')).toBe('saved report');
  expect(fs.readFileSync(sibling, 'utf8')).toBe('independent history');
  expect(fs.readFileSync(settings, 'utf8')).toBe('{}');
  expect(db.getRegisteredGroup(jid)).toBeDefined();
  const listing = await (await request('GET', '/sessions')).json();
  expect(listing.sessions.some((s: any) => s.id === 'main')).toBe(false);
  expect(
    service.getMainSessionSummary(jid, db.getRegisteredGroup(jid)!),
  ).toBeUndefined();
});
test('stop failure retains messages and all original context files', async () => {
  stop.mockRejectedValueOnce(new Error('stop failed'));
  expect((await request('DELETE')).status).toBe(500);
  expect(db.getMessage(jid, 'old-message')).not.toBeNull();
  expect(fs.readFileSync(mainFile, 'utf8')).toBe('original model history');
  expect(resume).toHaveBeenCalledTimes(1);
});
test('database failure rolls staged context and IPC input back', async () => {
  vi.spyOn(db, 'deleteMainConversation').mockImplementationOnce(() => {
    throw new Error('DB failure');
  });
  expect((await request('DELETE')).status).toBe(500);
  expect(fs.readFileSync(mainFile, 'utf8')).toBe('original model history');
  expect(fs.readFileSync(path.join(input, 'queued.json'), 'utf8')).toBe(
    'old input',
  );
  expect(db.getMessage(jid, 'old-message')).not.toBeNull();
  expect(db.getSession(folder)).toBe('old-main');
  expect(resume).toHaveBeenCalledTimes(1);
});
test('other users including admins cannot rename or delete this conversation', async () => {
  userId = 'other';
  expect((await request('DELETE')).status).toBe(404);
  expect(
    (await request('PATCH', '/sessions/main', { name: 'unauthorized' })).status,
  ).toBe(404);
  expect(stop).not.toHaveBeenCalled();
  expect(db.getMessage(jid, 'old-message')).not.toBeNull();
});
test('host permission and channel bindings are enforced before stopping or deleting', async () => {
  role = 'member';
  expect((await request('DELETE')).status).toBe(403);
  role = 'admin';
  db.setRegisteredGroup('telegram:bound', {
    name: '渠道',
    folder: 'channel-home',
    added_at: '2026-10-01',
    created_by: 'owner',
    target_main_jid: jid,
  });
  expect((await request('DELETE')).status).toBe(409);
  expect(stop).not.toHaveBeenCalled();
  expect(fs.existsSync(mainFile)).toBe(true);
});
test('new workspace has no mandatory main session; creating Web conversation uses isolated context', async () => {
  await request('DELETE');
  const created = await request('POST', '/sessions', { name: '新研究' });
  expect(created.status).toBe(200);
  const session = (await created.json()).session;
  expect(session.id).not.toBe('main');
  const listing = await (await request('GET', '/sessions')).json();
  expect(listing.sessions.map((s: any) => s.id)).toContain(session.id);
  expect(listing.sessions.some((s: any) => s.id === 'main')).toBe(false);
});

test('deleting an independent session waits for its own runner without stopping or removing default context', async () => {
  const created = await request('POST', '/sessions', { name: '可删除会话' });
  const session = (await created.json()).session;
  const history = path.join(
    root,
    'sessions',
    folder,
    'agents',
    session.id,
    '.claude',
    'sessions',
    'test.jsonl',
  );
  write(history, 'isolated history');
  stop.mockRejectedValueOnce(new Error('stop failed'));
  expect((await request('DELETE', `/sessions/${session.id}`)).status).toBe(500);
  expect(db.getAgent(session.id)).toBeDefined();
  expect(fs.existsSync(history)).toBe(true);
  stop.mockResolvedValueOnce(undefined);
  expect((await request('DELETE', `/sessions/${session.id}`)).status).toBe(200);
  expect(db.getAgent(session.id)).toBeUndefined();
  expect(fs.existsSync(history)).toBe(false);
  expect(
    stop.mock.calls.every(
      ([target]) => target === `${jid}#agent:${session.id}`,
    ),
  ).toBe(true);
  expect(fs.readFileSync(mainFile, 'utf8')).toBe('original model history');
  expect(db.getSession(folder)).toBe('old-main');
});
test('unsafe default context paths are rejected before stopping or moving any data', async () => {
  const unsafe = { ...db.getRegisteredGroup(jid)!, folder: '../groups' };
  await expect(
    service.deleteMainSession(jid, unsafe, context.getWebDeps()!),
  ).rejects.toThrow('Unsafe session folder');
  expect(stop).not.toHaveBeenCalled();
  expect(fs.readFileSync(report, 'utf8')).toBe('saved report');
});

async function independentHistory() {
  const created = await request('POST', '/sessions', { name: '回滚测试' });
  const session = (await created.json()).session;
  const contextDir = path.join(root, 'sessions', folder, 'agents', session.id);
  const ipcDir = path.join(root, 'ipc', folder, 'agents', session.id);
  const history = path.join(contextDir, '.claude', 'sessions', 'history.jsonl');
  const queued = path.join(ipcDir, 'input', 'queued.json');
  write(history, 'retained context');
  write(queued, 'retained input');
  db.setSession(folder, 'retained-runtime', session.id);
  db.setSessionChannelOwnerOnce(folder, session.id, 'web');
  const virtualJid = `${jid}#agent:${session.id}`;
  db.storeMessageDirect(
    'retained-message',
    virtualJid,
    'owner',
    'Owner',
    'retained message',
    '2026-10-02T00:00:00Z',
    false,
  );
  return { session, contextDir, history, queued, virtualJid };
}

function seedChannel(groupChat = false) {
  const id = randomUUID();
  const provider = groupChat ? 'telegram' : 'qq';
  db.createChannelAccount({
    id,
    owner_user_id: 'owner',
    provider,
    name: `Test channel ${id}`,
    secret_ref: `channel-account:${id}`,
    default_workspace_jid: jid,
  });
  const imJid = groupChat
    ? `telegram:-100123#account:${id}`
    : `qq:c2c:123#account:${id}`;
  db.setRegisteredGroup(imJid, {
    name: 'Test channel',
    folder: `channel-${id}`,
    added_at: '2026-10-02',
    created_by: 'owner',
    channel_account_id: id,
  });
  return imJid;
}

test('default deletion rechecks bindings added outside the API while stopping', async () => {
  stop.mockImplementationOnce(async () => {
    db.setRegisteredGroup('telegram:late-binding', {
      name: 'Late channel',
      folder: 'late-channel',
      added_at: '2026-10-02',
      created_by: 'owner',
      target_main_jid: jid,
    });
  });
  const response = await request('DELETE');
  expect(response.status).toBe(409);
  expect((await response.json()).linked_im_groups).toContainEqual({
    jid: 'telegram:late-binding',
    name: 'Late channel',
  });
  expect(db.getSession(folder)).toBe('old-main');
  expect(db.getMessage(jid, 'old-message')).not.toBeNull();
  expect(fs.readFileSync(mainFile, 'utf8')).toBe('original model history');
  expect(resume).toHaveBeenCalledTimes(1);
});

test('independent deletion rechecks bindings before staging or database changes', async () => {
  const { session, history, virtualJid } = await independentHistory();
  stop.mockImplementationOnce(async () => {
    db.setRegisteredGroup('telegram:late-binding', {
      name: 'Late channel',
      folder: 'late-channel',
      added_at: '2026-10-02',
      created_by: 'owner',
      target_agent_id: session.id,
    });
  });
  expect((await request('DELETE', `/sessions/${session.id}`)).status).toBe(409);
  expect(db.getAgent(session.id)).toBeDefined();
  expect(db.getMessage(virtualJid, 'retained-message')).not.toBeNull();
  expect(fs.readFileSync(history, 'utf8')).toBe('retained context');
});

test('a real SQLite failure after earlier deletes rolls back all records and restores both directories', async () => {
  const { session, history, queued, virtualJid } = await independentHistory();
  const connection = new Database(path.join(root, 'db', 'messages.db'));
  connection.exec(
    "CREATE TRIGGER fail_session_delete BEFORE DELETE ON agents BEGIN SELECT RAISE(ABORT, 'simulated late database failure'); END",
  );
  try {
    expect((await request('DELETE', `/sessions/${session.id}`)).status).toBe(
      500,
    );
    expect(db.getAgent(session.id)).toBeDefined();
    expect(db.getSession(folder, session.id)).toBe('retained-runtime');
    expect(db.getSessionChannelOwner(folder, session.id)).toBe('web');
    expect(db.getMessage(virtualJid, 'retained-message')).not.toBeNull();
    expect(fs.readFileSync(history, 'utf8')).toBe('retained context');
    expect(fs.readFileSync(queued, 'utf8')).toBe('retained input');
    expect(fs.readFileSync(report, 'utf8')).toBe('saved report');
  } finally {
    connection.exec('DROP TRIGGER fail_session_delete');
    connection.close();
  }
  expect((await request('DELETE', `/sessions/${session.id}`)).status).toBe(200);
  expect(db.getMessage(virtualJid, 'retained-message')).toBeNull();
  expect(db.getAgent(session.id)).toBeUndefined();
  expect(db.getSession(folder, session.id)).toBeUndefined();
  expect(db.getSessionChannelOwner(folder, session.id)).toBeUndefined();
  expect(fs.existsSync(history)).toBe(false);
  expect(fs.existsSync(queued)).toBe(false);
  expect(resume).toHaveBeenCalledTimes(2);
});

test('a failure staging the second directory restores the first without touching database records', async () => {
  const { session, contextDir, history, queued, virtualJid } =
    await independentHistory();
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
    if (source === contextDir) throw new Error('simulated rename failure');
    rename(source, destination);
  });
  expect((await request('DELETE', `/sessions/${session.id}`)).status).toBe(500);
  expect(fs.readFileSync(history, 'utf8')).toBe('retained context');
  expect(fs.readFileSync(queued, 'utf8')).toBe('retained input');
  expect(db.getMessage(virtualJid, 'retained-message')).not.toBeNull();
  expect(db.getSession(folder, session.id)).toBe('retained-runtime');
});

test.each(['main', 'workspace-alias', 'independent', 'agent-alias'])(
  'binding route %s rejects a target being deleted and duplicate deletion does not stop twice',
  async (target) => {
    const sessionId =
      target === 'main' || target === 'workspace-alias'
        ? 'main'
        : (await independentHistory()).session.id;
    const imJid = seedChannel(target === 'workspace-alias');
    const suffix =
      target === 'workspace-alias'
        ? '/im-binding'
        : target === 'agent-alias'
          ? `/agents/${sessionId}/im-binding`
          : `/sessions/${sessionId}/im-binding`;
    let started!: () => void, finish!: () => void;
    const stopping = new Promise<void>((resolve) => {
      started = resolve;
    });
    stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
          started();
        }),
    );
    const deletion = request('DELETE', `/sessions/${sessionId}`);
    await stopping;
    try {
      const response = await request('PUT', suffix, { im_jid: imJid });
      expect(response.status).toBe(409);
      expect((await response.json()).error).toMatch(/deletion/i);
      expect((await request('DELETE', `/sessions/${sessionId}`)).status).toBe(
        409,
      );
      expect(stop).toHaveBeenCalledTimes(1);
      expect(db.getRegisteredGroup(imJid)?.target_main_jid).toBeUndefined();
      expect(db.getRegisteredGroup(imJid)?.target_agent_id).toBeUndefined();
    } finally {
      finish();
      expect((await deletion).status).toBe(200);
    }
  },
);

test.each(['main', 'workspace-alias'])(
  'an older %s binding lookup cannot commit after default deletion completes',
  async (target) => {
    const imJid = seedChannel(target === 'workspace-alias');
    const suffix =
      target === 'workspace-alias'
        ? '/im-binding'
        : '/sessions/main/im-binding';
    const deps = context.getWebDeps()!;
    context.setWebDeps({
      ...deps,
      getChannelChatInfo: async () => {
        expect((await request('DELETE')).status).toBe(200);
        return null;
      },
    });
    const response = await request('PUT', suffix, { im_jid: imJid });
    expect(response.status).toBe(409);
    expect(db.getRegisteredGroup(imJid)?.target_main_jid).toBeUndefined();
    expect(db.getSession(folder)).toBeUndefined();
    // A fresh explicit request after deletion is allowed to create a new binding.
    context.setWebDeps(deps);
    expect((await request('PUT', suffix, { im_jid: imJid })).status).toBe(200);
  },
);

test('notification failure after database commit still returns successful deletion', async () => {
  const { session, history, virtualJid } = await independentHistory();
  const web = await import('../src/web.js');
  vi.spyOn(web, 'broadcastAgentRemoved').mockImplementationOnce(() => {
    throw new Error('simulated notification failure');
  });
  expect((await request('DELETE', `/sessions/${session.id}`)).status).toBe(200);
  expect(db.getAgent(session.id)).toBeUndefined();
  expect(db.getMessage(virtualJid, 'retained-message')).toBeNull();
  expect(fs.existsSync(history)).toBe(false);
  expect(resume).toHaveBeenCalledTimes(1);
});
