import { useEffect, useState } from 'react';
import { Globe, Link2, Link2Off, LoaderCircle, ShieldCheck } from 'lucide-react';
import { useAgents } from '../../agents/use-agents';
import { useTranslation } from '../../i18n';
import { ConnectionDialog } from './connection-dialog';
import { routeLabels } from './parts';

/** The connection to T3 Code at a glance, beside TV settings; OK opens its details. */
export function ConnectionButton() {
  const { t } = useTranslation();
  const { state } = useAgents();
  const [open, setOpen] = useState(false);

  // The launcher's Back handling doesn't know this dialog; take Back first.
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.keyCode !== 461) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [open]);

  if (!state.pairing || state.status === 'expired') return null;
  const kind = state.route?.kind;
  const connected = state.status === 'connected';
  const label = connected
    ? t((kind && routeLabels[kind]) || 'agentViaLan')
    : t(state.status === 'offline' ? 'agentsOffline' : 'agentsReconnecting');
  const icon = !connected ? (
    state.status === 'offline' ? (
      <Link2Off strokeWidth={1.8} />
    ) : (
      <LoaderCircle className="spin" strokeWidth={1.8} />
    )
  ) : kind === 'tailnet' || kind === 'vpn' ? (
    <ShieldCheck strokeWidth={1.8} />
  ) : kind === 'public' ? (
    <Globe strokeWidth={1.8} />
  ) : (
    <Link2 strokeWidth={1.8} />
  );
  return (
    <>
      <button
        className={`icon-button connection-button${connected ? '' : ' is-warning'}`}
        data-focusable="agents-connection"
        aria-label={label}
        title={label}
        onClick={() => setOpen(true)}
      >
        {icon}
      </button>
      {open ? <ConnectionDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}
