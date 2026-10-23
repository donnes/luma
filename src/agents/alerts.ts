import type { MessageKey } from '../i18n';
import { inboxGroups, type Agent, type Shell } from './model';

/** What an alert shows. HomeGuard on Fire TV builds the same from its own connection. */
export interface AgentAlert {
  requestId: string;
  threadId: string;
  /** "Needs you · asked a question" */
  headline: string;
  title: string;
  /** The project, under the title. */
  detail: string;
  /** The server's name, top right. */
  source: string;
}

export const alertHeadline = (t: (key: MessageKey) => string, status: 'input' | 'approval') =>
  `${t('agentNeedsYou')} · ${t(status === 'input' ? 'agentAlertAsked' : 'agentAlertApproval')}`;

export const agentAlert = (
  agent: Agent,
  t: (key: MessageKey) => string,
  source: string,
): AgentAlert => ({
  requestId: agent.thread.pendingRuntimeRequest?.id ?? '',
  threadId: agent.thread.id,
  headline: alertHeadline(t, agent.status === 'input' ? 'input' : 'approval'),
  title: agent.thread.title,
  detail: agent.project?.title ?? '',
  source,
});

// Requests Luma has already alerted about, kept across restarts so that a
// reconnect's snapshot doesn't announce them again.
const STORAGE_KEY = 'luma.agentAlerts.v1';
/** Request ids are never reused; the newest few hundred cover everything still pending. */
const REMEMBERED = 200;

export function loadSeen(): string[] | null {
  try {
    const seen: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return Array.isArray(seen) ? seen.filter((id) => typeof id === 'string') : null;
  } catch {
    return null;
  }
}

export function saveSeen(seen: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seen));
  } catch {
    /* Without storage, a restart may alert once more. */
  }
}

/**
 * The agents that newly need you: those whose pending request isn't in
 * `seen`. Keyed by request, so an agent alerts again only for a new request,
 * and a request that flips between blocking and not doesn't. With no history
 * at all (`seen` null, Luma's first snapshot ever), what is already waiting
 * is recorded without an alert.
 */
export function takeAlerts(shell: Shell, seen: string[] | null) {
  const known = new Set(seen);
  const fresh = inboxGroups(shell).needsYou.flatMap((agent) => {
    const id = agent.thread.pendingRuntimeRequest?.id;
    return id === undefined || known.has(id) ? [] : [{ agent, id }];
  });
  // Unchanged history keeps its identity, so callers can skip saving it.
  if (seen && !fresh.length) return { alerts: [] as Agent[], seen };
  return {
    alerts: seen ? fresh.map(({ agent }) => agent) : [],
    seen: [...(seen ?? []), ...fresh.map(({ id }) => id)].slice(-REMEMBERED),
  };
}
