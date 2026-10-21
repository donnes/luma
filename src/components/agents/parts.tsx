import { useCallback, useState } from 'react';
import { LoaderCircle, MessageCircle } from 'lucide-react';
import {
  isWorking,
  type Agent,
  type AgentStatus,
  type PendingRequest,
  type Step,
} from '../../agents/model';
import type { RouteKind } from '../../agents/routes';
import type { RequestKind } from '../../agents/types';
import { useAgents } from '../../agents/use-agents';
import { projectMark } from './format';
import { useTranslation, type MessageKey } from '../../i18n';

export const statusLabels: Record<AgentStatus, MessageKey> = {
  input: 'agentNeedsYou',
  approval: 'agentNeedsYou',
  starting: 'agentStarting',
  running: 'agentWorking',
  done: 'agentDone',
  error: 'agentFailed',
  idle: 'agentIdle',
};

export const stepLabels: Record<Exclude<Step['label'], 'status'>, MessageKey> = {
  ran: 'agentStepRan',
  edited: 'agentStepEdited',
  searched: 'agentStepSearched',
  searchedWeb: 'agentStepSearchedWeb',
};

/** One tool step: a verb and what it acted on, or just T3's own status line. */
export function StepText({ step }: { step: Step }) {
  const { t } = useTranslation();
  if (step.label === 'status') return <span>{step.detail}</span>;
  return (
    <>
      <span>{t(stepLabels[step.label])}</span>
      <code>{step.detail}</code>
    </>
  );
}

export const requestLabels: Partial<Record<RequestKind, MessageKey>> = {
  command: 'agentWantsCommand',
  'file-change': 'agentWantsEdit',
  'file-read': 'agentWantsRead',
  'mcp-elicitation': 'agentWantsTool',
  permission: 'agentWantsPermission',
};

export const routeLabels: Partial<Record<RouteKind, MessageKey>> = {
  lan: 'agentViaLan',
  tailnet: 'agentViaTailscale',
  vpn: 'agentViaVpn',
  loopback: 'agentViaLocal',
  public: 'agentViaInternet',
};

export const routeKindLabels: Record<RouteKind, MessageKey> = {
  lan: 'agentRouteLan',
  tailnet: 'agentRouteTailscale',
  vpn: 'agentRouteVpn',
  loopback: 'agentRouteLocal',
  public: 'agentRouteInternet',
};

export function StatusIndicator({ status }: { status: AgentStatus }) {
  if (isWorking(status)) return <span className="agent-spinner" aria-hidden="true" />;
  return <span className={`agent-dot agent-dot-${status}`} aria-hidden="true" />;
}

export function ProjectMark({ agent }: { agent: Pick<Agent, 'project'> }) {
  const mark = projectMark(agent.project);
  return (
    <span className={`project-mark tone-${mark.tone}`} aria-hidden="true">
      {mark.initials}
    </span>
  );
}

export function useAgentActions(threadId: string | undefined) {
  const { t } = useTranslation();
  const { connection } = useAgents();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (action: () => Promise<unknown>, onError: (text: string) => void) => {
      if (!threadId) return false;
      setBusy(true);
      try {
        await action();
        return true;
      } catch {
        onError(t('agentActionFailed'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [t, threadId],
  );
  return { busy, run, connection };
}

export function RequestSummary({
  pending,
  agent,
}: {
  pending: PendingRequest | null;
  agent: Agent;
}) {
  const { t } = useTranslation();
  if (pending?.kind === 'input') {
    const [first, ...rest] = pending.questions;
    return (
      <div className="agent-ask">
        <MessageCircle />
        <span className="agent-question">
          {first.question}
          {rest.length ? <small>{t('agentMoreQuestions', { count: rest.length })}</small> : null}
        </span>
      </div>
    );
  }
  const kind = pending?.requestKind ?? agent.thread.pendingRuntimeRequest?.kind;
  const label = kind ? requestLabels[kind] : undefined;
  return (
    <div className="agent-ask">
      <span>{t(label ?? 'agentWantsPermission')}</span>
      {pending?.kind === 'approval' && pending.detail ? (
        <code className="agent-command">{pending.detail}</code>
      ) : !pending ? (
        <LoaderCircle className="spin" />
      ) : null}
    </div>
  );
}
