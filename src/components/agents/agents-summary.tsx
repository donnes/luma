import { useAgents } from '../../agents/use-agents';
import { useTranslation } from '../../i18n';

/** "2 agents need you · 3 working" under the greeting, only while something is happening. */
export function AgentsSummary({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const { state, waiting, working } = useAgents();
  if (state.status !== 'connected' || (!waiting && !working)) return null;
  const parts = [
    waiting
      ? t(waiting === 1 ? 'agentsSummaryWaitingOne' : 'agentsSummaryWaiting', { count: waiting })
      : '',
    working ? t('agentsSummaryWorking', { count: working }) : '',
  ].filter(Boolean);
  return (
    <button
      className={`agents-summary${waiting ? ' needs-you' : ''}`}
      data-focusable="agents-summary"
      onClick={onOpen}
    >
      <span
        className={`agent-dot agent-dot-${waiting ? 'approval' : 'running'}`}
        aria-hidden="true"
      />
      {parts.join(' · ')}
    </button>
  );
}
