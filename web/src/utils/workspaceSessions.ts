import type { AgentInfo, GroupInfo } from '../types';

export function workspaceSessions(
  group: GroupInfo | undefined,
  agents: AgentInfo[],
): AgentInfo[] {
  const conversations = agents.filter((agent) => agent.kind === 'conversation');
  const legacy = group?.main_session;
  return [
    ...(legacy
      ? [
          {
            id: 'main',
            name: legacy.name,
            prompt: '',
            status: 'idle' as const,
            kind: 'conversation' as const,
            created_at: legacy.created_at,
            last_active_at: legacy.last_active_at,
            latest_message: legacy.latest_message,
            linked_im_groups: legacy.linked_im_groups,
          },
        ]
      : []),
    ...conversations,
  ].sort((a, b) => {
    const activity = (session: AgentInfo) =>
      Date.parse(
        session.last_active_at ||
          session.latest_message?.timestamp ||
          session.created_at,
      ) || 0;
    return activity(b) - activity(a);
  });
}

export function restoredSessionId(
  sessions: AgentInfo[],
  remembered: string | null,
): string | null {
  return (
    sessions.find((session) => session.id === remembered)?.id ??
    sessions[0]?.id ??
    null
  );
}
