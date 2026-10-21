// The subset of T3 Code's orchestration v2 wire shapes that Luma reads. The
// authoritative schemas live in T3 Code's packages/contracts; fields Luma
// doesn't use are left out, and everything else is treated as untrusted input.

export type RunStatus =
  | 'preparing'
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'cancelled'
  | 'rolled_back';

export type RequestKind =
  | 'command'
  | 'file-read'
  | 'file-change'
  | 'mcp-elicitation'
  | 'permission'
  | 'dynamic_tool_call'
  | 'user_input'
  | 'auth_refresh';

export type ApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'acceptAlways'
  | 'decline'
  | 'cancel';

export interface ProjectShell {
  id: string;
  title: string;
}

export interface ThreadShell {
  id: string;
  projectId: string;
  title: string;
  modelSelection?: { model?: string };
  status: 'idle' | RunStatus;
  activityRunStatus?: 'preparing' | 'starting' | 'running' | 'waiting' | null;
  activeRunId: string | null;
  lastError?: string | null;
  pendingRuntimeRequest: {
    id: string;
    kind: RequestKind;
    createdAt: string;
    blocking?: boolean;
  } | null;
  latestVisibleMessage: { role: string; text: string; updatedAt: string } | null;
  latestRunStartedAt?: string | null;
  createdAt: string;
  branch: string | null;
  lineage?: { relationshipToParent: 'fork' | 'subagent' | null };
  settledOverride: 'settled' | 'active' | null;
  settledAt: string | null;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
}

export interface ShellSnapshot {
  snapshotSequence: number;
  projects: ProjectShell[];
  threads: ThreadShell[];
}

export type ShellStreamItem =
  | { kind: 'snapshot'; snapshot: ShellSnapshot }
  | { kind: 'synchronized' }
  | { kind: 'project.updated'; sequence: number; project: ProjectShell }
  | { kind: 'project.removed'; sequence: number; projectId: string }
  | {
      kind: 'thread.updated';
      sequence: number;
      location: 'active' | 'archive';
      thread: ThreadShell;
    }
  | { kind: 'thread.removed'; sequence: number; threadId: string };

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string; value?: string }[];
  multiSelect?: boolean;
  allowCustomAnswer?: boolean;
}

interface TurnItemBase {
  id: string;
  ordinal: number;
  status: string;
  title: string | null;
  runId: string | null;
}

export type TurnItem = TurnItemBase &
  (
    | { type: 'user_message'; text: string }
    | { type: 'assistant_message'; text: string; streaming: boolean }
    | { type: 'command_execution'; input: string; exitCode?: number }
    | { type: 'file_change'; fileName: string; additions?: number; deletions?: number }
    | { type: 'file_search'; pattern?: string }
    | { type: 'web_search'; patterns?: string[] }
    | {
        type: 'approval_request';
        requestId: string;
        requestKind: RequestKind;
        prompt?: string;
        options?: { decision: ApprovalDecision; label: string }[];
      }
    | { type: 'user_input_request'; requestId: string; questions: UserInputQuestion[] }
    // Reasoning, plans, checkpoints and newer item types aren't shown on the TV.
    | { type: 'other' }
  );

export interface RuntimeRequest {
  id: string;
  kind: RequestKind;
  status: 'pending' | 'resolved' | 'expired' | 'cancelled';
  createdAt: string;
}

export interface ThreadProjection {
  turnItems: TurnItem[];
  runtimeRequests: RuntimeRequest[];
}

export type ThreadStreamItem =
  | { kind: 'snapshot'; snapshotSequence: number; projection: ThreadProjection }
  | { kind: 'synchronized' }
  | {
      kind: 'event';
      sequence: number;
      event: { type: string; payload: unknown };
    };

export interface DirectEndpoint {
  kind: 'lan' | 'tailnet';
  httpBaseUrl: string;
}
