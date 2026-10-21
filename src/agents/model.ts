import type {
  ApprovalDecision,
  ProjectShell,
  RequestKind,
  RuntimeRequest,
  ShellStreamItem,
  ThreadProjection,
  ThreadShell,
  ThreadStreamItem,
  TurnItem,
  UserInputQuestion,
} from './types';

export type AgentStatus = 'input' | 'approval' | 'starting' | 'running' | 'done' | 'error' | 'idle';

// Mirrors T3 Code's packages/shared/src/agentAwareness.ts so the TV and the
// desktop agree on which agents are waiting for you.
export function agentStatus(thread: ThreadShell): AgentStatus {
  const run = thread.activityRunStatus ?? thread.status;
  const active =
    run === 'preparing' || run === 'starting' || run === 'running' || run === 'waiting';
  const request = thread.pendingRuntimeRequest;
  if (request?.kind === 'user_input' && (request.blocking !== false || !active)) return 'input';
  if (request && request.kind !== 'user_input' && request.kind !== 'auth_refresh')
    return 'approval';
  if (run === 'preparing' || run === 'starting') return 'starting';
  if (run === 'running' || run === 'waiting') return 'running';
  if (run === 'completed') return 'done';
  if (run === 'failed') return 'error';
  return 'idle';
}

export const needsYou = (status: AgentStatus) => status === 'input' || status === 'approval';
export const isWorking = (status: AgentStatus) => status === 'starting' || status === 'running';

export interface Agent {
  thread: ThreadShell;
  project: ProjectShell | undefined;
  status: AgentStatus;
}

export interface Shell {
  projects: Map<string, ProjectShell>;
  threads: Map<string, ThreadShell>;
  sequence: number;
  ready: boolean;
}

export const emptyShell = (): Shell => ({
  projects: new Map(),
  threads: new Map(),
  sequence: 0,
  ready: false,
});

export function applyShellItem(shell: Shell, item: ShellStreamItem): Shell {
  switch (item.kind) {
    case 'snapshot': {
      // A later snapshot without threads refreshes metadata for some projects;
      // it isn't the full list, so it merges into the projects already known.
      if (shell.ready && !item.snapshot.threads.length) {
        const projects = new Map(shell.projects);
        for (const project of item.snapshot.projects) projects.set(project.id, project);
        return { ...shell, projects };
      }
      return {
        projects: new Map(item.snapshot.projects.map((project) => [project.id, project])),
        threads: new Map(item.snapshot.threads.map((thread) => [thread.id, thread])),
        sequence: item.snapshot.snapshotSequence,
        ready: true,
      };
    }
    case 'synchronized':
      return shell;
  }
  if (item.sequence <= shell.sequence) return shell;
  const next = { ...shell, sequence: item.sequence };
  switch (item.kind) {
    case 'project.updated':
      next.projects = new Map(shell.projects).set(item.project.id, item.project);
      break;
    case 'project.removed':
      next.projects = new Map(shell.projects);
      next.projects.delete(item.projectId);
      break;
    case 'thread.updated':
      next.threads = new Map(shell.threads);
      if (item.location === 'active') next.threads.set(item.thread.id, item.thread);
      else next.threads.delete(item.thread.id);
      break;
    case 'thread.removed':
      next.threads = new Map(shell.threads);
      next.threads.delete(item.threadId);
      break;
  }
  return next;
}

const RECENT_MS = 24 * 60 * 60 * 1000;
export const SHELF_SIZE = 12;

// Needs-you agents first (oldest request first, since it's been waiting
// longest), then working agents, then unsettled agents from the last day.
// Working agents sort by when their run started, not by their last update:
// every step a running agent takes bumps updatedAt and would reshuffle the shelf.
export function shelfAgents(shell: Shell, now = Date.now()): Agent[] {
  const agents: Agent[] = [];
  for (const thread of shell.threads.values()) {
    if (
      thread.archivedAt ||
      thread.deletedAt ||
      thread.lineage?.relationshipToParent === 'subagent'
    )
      continue;
    const status = agentStatus(thread);
    const settled =
      thread.settledOverride === 'settled' ||
      (thread.settledAt !== null && thread.settledOverride !== 'active');
    const recent = now - Date.parse(thread.updatedAt) < RECENT_MS;
    if (!needsYou(status) && !isWorking(status) && (settled || !recent)) continue;
    agents.push({ thread, project: shell.projects.get(thread.projectId), status });
  }
  const rank = (agent: Agent) => (needsYou(agent.status) ? 0 : isWorking(agent.status) ? 1 : 2);
  return agents
    .sort((a, b) => {
      const byRank = rank(a) - rank(b);
      if (byRank) return byRank;
      if (rank(a) === 0)
        return (
          Date.parse(a.thread.pendingRuntimeRequest!.createdAt) -
          Date.parse(b.thread.pendingRuntimeRequest!.createdAt)
        );
      const since = (agent: Agent) =>
        Date.parse(
          rank(agent) === 1
            ? (agent.thread.latestRunStartedAt ?? agent.thread.createdAt)
            : agent.thread.updatedAt,
        );
      return since(b) - since(a) || a.thread.id.localeCompare(b.thread.id);
    })
    .slice(0, SHELF_SIZE);
}

// --- Thread detail -------------------------------------------------------

export interface ThreadDetail {
  threadId: string;
  sequence: number;
  items: Map<string, TurnItem>;
  requests: Map<string, RuntimeRequest>;
  ready: boolean;
}

export const emptyDetail = (threadId: string): ThreadDetail => ({
  threadId,
  sequence: 0,
  items: new Map(),
  requests: new Map(),
  ready: false,
});

const shownItems = new Set([
  'user_message',
  'assistant_message',
  'command_execution',
  'file_change',
  'file_search',
  'web_search',
  'approval_request',
  'user_input_request',
]);

// Unknown or unshown item types collapse to `other` so new server item types
// can't break rendering.
export function toTurnItem(raw: unknown): TurnItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as TurnItem & { type: string };
  if (typeof item.id !== 'string' || typeof item.ordinal !== 'number') return null;
  return shownItems.has(item.type) ? item : { ...item, type: 'other' };
}

function withProjection(detail: ThreadDetail, projection: ThreadProjection): ThreadDetail {
  const items = new Map<string, TurnItem>();
  for (const raw of projection.turnItems) {
    const item = toTurnItem(raw);
    if (item) items.set(item.id, item);
  }
  return {
    ...detail,
    items,
    requests: new Map(projection.runtimeRequests.map((request) => [request.id, request])),
    ready: true,
  };
}

export function applyThreadItem(detail: ThreadDetail, item: ThreadStreamItem): ThreadDetail {
  if (item.kind === 'synchronized') return detail;
  if (item.kind === 'snapshot')
    return { ...withProjection(detail, item.projection), sequence: item.snapshotSequence };
  if (item.sequence <= detail.sequence) return detail;
  const next = { ...detail, sequence: item.sequence };
  const { type, payload } = item.event;
  if (type === 'turn-item.updated') {
    const turnItem = toTurnItem(payload);
    if (turnItem) next.items = new Map(detail.items).set(turnItem.id, turnItem);
  } else if (type === 'runtime-request.updated') {
    const request = payload as RuntimeRequest;
    next.requests = new Map(detail.requests).set(request.id, request);
  }
  return next;
}

export const orderedItems = (detail: ThreadDetail) =>
  [...detail.items.values()].sort((a, b) => a.ordinal - b.ordinal);

export interface PendingApproval {
  kind: 'approval';
  requestId: string;
  requestKind: RequestKind;
  detail: string;
  options: { decision: ApprovalDecision; label: string }[];
}

export interface PendingQuestion {
  kind: 'input';
  requestId: string;
  questions: UserInputQuestion[];
}

export type PendingRequest = PendingApproval | PendingQuestion;

const defaultDecisions: { decision: ApprovalDecision; label: string }[] = [
  { decision: 'accept', label: 'Approve' },
  { decision: 'acceptForSession', label: 'Allow for this session' },
  { decision: 'decline', label: 'Deny' },
];

function lastWhere<T>(items: T[], match: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index--)
    if (match(items[index])) return items[index];
  return undefined;
}

// Same pairing of runtime requests and their turn items as T3 Code's
// derivePendingThreadRequests; the oldest pending request comes first.
export function pendingRequest(detail: ThreadDetail): PendingRequest | null {
  const items = orderedItems(detail);
  const pending = [...detail.requests.values()]
    .filter(
      (request) =>
        request.status === 'pending' &&
        request.kind !== 'auth_refresh' &&
        request.kind !== 'dynamic_tool_call',
    )
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const request of pending) {
    if (request.kind === 'user_input') {
      const item = lastWhere(
        items,
        (candidate) =>
          candidate.type === 'user_input_request' && candidate.requestId === request.id,
      );
      if (item?.type === 'user_input_request')
        return { kind: 'input', requestId: request.id, questions: item.questions };
      continue;
    }
    const item = lastWhere(
      items,
      (candidate) => candidate.type === 'approval_request' && candidate.requestId === request.id,
    );
    const approval = item?.type === 'approval_request' ? item : undefined;
    const options = approval?.options?.filter((option) => option.decision !== 'cancel');
    return {
      kind: 'approval',
      requestId: request.id,
      requestKind: request.kind,
      detail: approval?.prompt?.trim() || approval?.title || '',
      options: options?.length ? options : defaultDecisions,
    };
  }
  return null;
}

export interface Step {
  id: string;
  label: 'status' | 'ran' | 'edited' | 'searched' | 'searchedWeb';
  detail: string;
  status: string;
}

// One line per tool call: what it did and to what.
export function stepOf(item: TurnItem): Step | null {
  const base = { id: item.id, status: item.status };
  switch (item.type) {
    case 'command_execution':
      // Titled commands are T3's own steps, like "Workspace ready"; the title reads better.
      return item.title
        ? { ...base, label: 'status', detail: item.title }
        : { ...base, label: 'ran', detail: item.input };
    case 'file_change':
      return { ...base, label: 'edited', detail: item.fileName };
    case 'file_search':
      return { ...base, label: 'searched', detail: item.pattern ?? item.title ?? '' };
    case 'web_search':
      return { ...base, label: 'searchedWeb', detail: item.patterns?.join(', ') ?? '' };
    default:
      return null;
  }
}

export function lastAssistantText(detail: ThreadDetail): string {
  const items = orderedItems(detail);
  const item = lastWhere(items, (candidate) => candidate.type === 'assistant_message');
  return item?.type === 'assistant_message' ? item.text : '';
}

export const recentSteps = (detail: ThreadDetail, count = 3): Step[] =>
  orderedItems(detail)
    .flatMap((item) => stepOf(item) ?? [])
    .slice(-count);

// Markdown is shown as plain text on the TV: strip the syntax, keep the words.
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function summary(text: string, max = 280): string {
  const plain = plainText(text).replace(/\s+/g, ' ');
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20))}…`;
}

// "claude-opus-5-5" → "Claude Opus 5.5", "gpt-5.5-codex" → "GPT 5.5 Codex".
export function modelLabel(model: string | undefined): string {
  if (!model) return '';
  return model
    .replace(/^claude-/, 'Claude-')
    .replace(/-(\d+)-(\d+)(?=$|-)/, ' $1.$2')
    .split(/[-_]/)
    .map((part) => (/^gpt$/i.test(part) ? 'GPT' : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}
