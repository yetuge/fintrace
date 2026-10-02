// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useChatStore } from '../../stores/chat';
import { ChatView } from './ChatView';
import type { AgentInfo, GroupInfo } from '../../types';
const mocks = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), del: vi.fn() }));
vi.mock('../../api/client', () => ({
  api: { get: mocks.get, post: mocks.post, delete: mocks.del, patch: vi.fn() },
}));
vi.mock('../../api/ws', () => ({
  wsManager: { on: () => () => {}, send: vi.fn(), isConnected: () => true },
}));
vi.mock('../../utils/toast', () => ({
  showToast: vi.fn(),
  notifyIfHidden: vi.fn(),
  shouldEmitBackgroundTaskNotice: () => false,
  showNotificationPromptToast: vi.fn(),
}));
vi.mock('../../utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: vi.fn(),
  deleteGroupMessageSnapshots: vi.fn(),
  loadAgentMessageSnapshot: async () => null,
  saveAgentMessageSnapshot: vi.fn(),
}));
vi.mock('../../hooks/useDisplayMode', () => ({
  useDisplayMode: () => ({ mode: 'chat', toggle: vi.fn() }),
}));
vi.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'light', toggle: vi.fn() }),
}));
vi.mock('./MessageList', () => ({ MessageList: () => null }));
vi.mock('./FilePanel', () => ({ FilePanel: () => null }));
vi.mock('./ContainerEnvPanel', () => ({ ContainerEnvPanel: () => null }));
vi.mock('./ImBindingDialog', () => ({ ImBindingDialog: () => null }));
vi.mock('./WorkspaceInteractionModeDialog', () => ({
  WorkspaceInteractionModeDialog: () => null,
}));
vi.mock('./MessageInput', () => ({
  MessageInput: ({ onSend }: { onSend: (text: string) => Promise<boolean> }) =>
    React.createElement(
      'button',
      { onClick: () => void onSend('研究问题') },
      '发送测试消息',
    ),
}));
// The menu/confirmation itself is exercised with real Radix in SessionSidebar.test.
vi.mock('./SessionSidebar', () => ({
  SessionSidebar: ({
    sessions,
    onDeleteSession,
  }: {
    sessions: AgentInfo[];
    onDeleteSession: (id: string) => Promise<boolean>;
  }) =>
    React.createElement(
      'div',
      {},
      ...sessions.map((session) =>
        React.createElement(
          'button',
          { key: session.id, onClick: () => void onDeleteSession(session.id) },
          `删除 ${session.id}`,
        ),
      ),
    ),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const initial = useChatStore.getState();
const jid = 'web:ui-sessions';
const group: GroupInfo = {
  name: '研究',
  folder: 'ui-sessions',
  added_at: '2026-10-01',
  interaction_mode: 'assistant',
  can_modify: true,
  execution_mode: 'host',
};
const session = (id: string, date: string): AgentInfo => ({
  id,
  name: id,
  prompt: '',
  kind: 'conversation',
  status: 'completed',
  created_at: date,
});
let root: Root | undefined, host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  window.matchMedia = vi.fn(
    () =>
      ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
  mocks.get.mockResolvedValue({
    messages: [],
    hasMore: false,
    follow_ups: [],
    active: false,
  });
  mocks.del.mockResolvedValue({ success: true });
  useChatStore.setState(
    {
      ...initial,
      groups: { [jid]: group },
      currentGroup: jid,
      agents: { [jid]: [] },
      messages: { [jid]: [] },
      agentMessages: {},
      activeAgentTab: {},
      streaming: {},
      waiting: {},
      agentStreaming: {},
      agentWaiting: {},
    },
    true,
  );
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
});
function Location() {
  const location = useLocation();
  return React.createElement('output', {}, location.search);
}
async function render(search = '') {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: [`/chat${search}`] },
        React.createElement(
          Routes,
          {},
          React.createElement(Route, {
            path: '/chat',
            element: React.createElement(
              React.Fragment,
              {},
              React.createElement(ChatView, { groupJid: jid }),
              React.createElement(Location),
            ),
          }),
        ),
      ),
    ),
  );
}
async function click(text: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent === text,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
test('empty desktop workbench creates an isolated conversation for the first message and forwards that message once', async () => {
  mocks.post
    .mockResolvedValueOnce({ session: session('new', '2026-10-02') })
    .mockResolvedValueOnce({
      success: true,
      messageId: 'sent',
      disposition: 'started',
    });
  await render();
  await click('发送测试消息');
  expect(mocks.post.mock.calls).toEqual([
    [
      '/api/groups/web%3Aui-sessions/sessions',
      { name: '', description: undefined },
    ],
    [
      '/api/messages',
      {
        chatJid: jid,
        agentId: 'new',
        content: '研究问题',
        attachments: undefined,
        followUpBehavior: 'queue',
      },
    ],
  ]);
  expect(host.querySelector('output')!.textContent).toBe('?agent=new');
});
test('desktop /chat restores last selected session, including former main', async () => {
  useChatStore.setState({
    groups: {
      [jid]: {
        ...group,
        main_session: {
          name: '旧会话',
          created_at: '2026-10-01',
          last_active_at: '2026-10-01',
          latest_message: null,
        },
      },
    },
    agents: { [jid]: [session('newer', '2026-10-02')] },
  });
  localStorage.setItem(
    'miniclaw-workspace-last-agent',
    JSON.stringify({ [jid]: 'main' }),
  );
  await render();
  expect(host.querySelector('output')!.textContent).toBe('?agent=main');
});
test('deleting the selected former main switches to the most recently active survivor', async () => {
  useChatStore.setState({
    groups: {
      [jid]: {
        ...group,
        main_session: {
          name: '旧会话',
          created_at: '2026-10-01',
          last_active_at: '2026-10-01',
          latest_message: null,
        },
      },
    },
    agents: {
      [jid]: [session('older', '2026-10-02'), session('recent', '2026-10-03')],
    },
  });
  await render('?agent=main');
  await click('删除 main');
  expect(host.querySelector('output')!.textContent).toBe('?agent=recent');
  expect(useChatStore.getState().groups[jid].main_session).toBeUndefined();
});
test('deleting the last conversation leaves an empty page without a main row or stale URL', async () => {
  useChatStore.setState({ agents: { [jid]: [session('only', '2026-10-02')] } });
  await render('?agent=only');
  await click('删除 only');
  expect(host.querySelector('output')!.textContent).toBe('');
  expect(useChatStore.getState().agents[jid]).toEqual([]);
  expect(host.textContent).not.toContain('删除 main');
});
