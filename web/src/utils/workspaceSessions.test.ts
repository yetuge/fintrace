import { expect, test } from 'vitest';
import { workspaceSessions, restoredSessionId } from './workspaceSessions';
import type { AgentInfo, GroupInfo } from '../types';
const group: GroupInfo = {
  name: '研究',
  folder: 'research',
  added_at: '2026-01-01',
  interaction_mode: 'assistant',
};
const session = (id: string, activity: string): AgentInfo => ({
  id,
  name: id,
  prompt: '',
  kind: 'conversation',
  status: 'completed',
  created_at: activity,
});
test('empty workspaces and isolated conversations have no fabricated main session', () => {
  expect(workspaceSessions(group, [])).toEqual([]);
  expect(
    workspaceSessions(group, [session('one', '2026-01-02')]).map((s) => s.id),
  ).toEqual(['one']);
  expect(restoredSessionId([], 'deleted')).toBeNull();
});
test('legacy main is included only when persisted and ordered by activity alongside other sessions', () => {
  const sessions = workspaceSessions(
    {
      ...group,
      main_session: {
        name: '旧研究',
        created_at: '2026-01-01',
        last_active_at: '2026-01-03',
        latest_message: null,
      },
    },
    [session('recent', '2026-01-04'), session('older', '2026-01-02')],
  );
  expect(sessions.map((s) => s.id)).toEqual(['recent', 'main', 'older']);
  expect(restoredSessionId(sessions, 'older')).toBe('older');
  expect(restoredSessionId(sessions, 'main')).toBe('main');
  expect(restoredSessionId(sessions, 'deleted')).toBe('recent');
});
test('deleting the current session selects the most recently active survivor, including legacy main', () => {
  const all = [
    session('removed', '2026-01-05'),
    session('recent', '2026-01-04'),
    session('older', '2026-01-02'),
  ];
  expect(
    restoredSessionId(
      workspaceSessions(
        group,
        all.filter((s) => s.id !== 'removed'),
      ),
      'removed',
    ),
  ).toBe('recent');
  expect(restoredSessionId(workspaceSessions(group, []), 'removed')).toBeNull();
});
