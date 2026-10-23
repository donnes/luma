import { Inbox } from 'lucide-react';
import { useAgents } from '../../agents/use-agents';
import { useTranslation } from '../../i18n';

/** Beside Open T3 Code: every thread at a glance, with a count of the ones waiting on you. */
export function InboxButton({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const { state, waiting } = useAgents();
  if (!state.pairing || state.status === 'expired' || !state.shell.ready) return null;
  return (
    <button className="icon-button inbox-button" data-focusable="agents-inbox" onClick={onOpen}>
      <Inbox strokeWidth={1.8} />
      {t('agentsInbox')}
      {waiting ? (
        <span className="inbox-button-count" aria-label={t('agentsWaiting', { count: waiting })}>
          {waiting}
        </span>
      ) : null}
    </button>
  );
}
