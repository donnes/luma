import { Link2, Unplug } from 'lucide-react';
import { useAgents } from '../../agents/use-agents';
import { useTranslation } from '../../i18n';
import { Dialog } from '../dialog';
import { routeKindLabels, routeLabels } from './parts';

/** The paired server, the addresses Luma knows for it, and Unpair. */
export function ConnectionDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { state, connection } = useAgents();
  const pairing = state.pairing;
  if (!pairing) return null;
  const status =
    state.status === 'connected' && state.route
      ? t(routeLabels[state.route.kind] ?? 'agentViaLan')
      : t(state.status === 'offline' ? 'agentsOffline' : 'agentsConnectingShort');
  return (
    <Dialog title={pairing.label || 'T3 Code'} subtitle={status} onClose={onClose}>
      <ul className="paired-routes" aria-label={t('agentsAddresses')}>
        {pairing.routes.map((route) => (
          <li key={route.url} className={state.route?.url === route.url ? 'active' : ''}>
            <Link2 aria-hidden="true" />
            <span>{route.url.replace(/\/$/, '')}</span>
            <small>{t(routeKindLabels[route.kind])}</small>
          </li>
        ))}
      </ul>
      <div className="app-actions">
        <button
          className="setting-row"
          data-focusable="agents-unpair"
          onClick={() => {
            onClose();
            connection.unpair();
          }}
        >
          <Unplug />
          <span>
            <strong>{t('agentsUnpair')}</strong>
            <small>{t('agentsUnpairHint')}</small>
          </span>
        </button>
      </div>
    </Dialog>
  );
}
