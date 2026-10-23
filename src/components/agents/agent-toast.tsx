import { useEffect } from 'react';
import type { AgentAlert } from '../../agents/alerts';
import { T3Glyph } from './agents-mark';
import './agent-toast.css';

/** How long an alert stays up; agent-toast.css fades it out just before. */
export const AGENT_TOAST_MS = 6000;

// An agent that newly needs you, top right for a few seconds. It never takes
// focus or keys, so whatever is on screen keeps the remote, and it owns its
// styles like the inbox, so it renders the same outside Luma's pages. Key it
// by queue entry so each alert starts its timer and animation over, even one
// for the same request as the last; `onDone` should keep its identity.
export function AgentToast({ alert, onDone }: { alert: AgentAlert; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, AGENT_TOAST_MS);
    return () => clearTimeout(timer);
  }, [onDone]);
  return (
    <aside className="agent-toast" role="status">
      <span className="agent-toast-bar" aria-hidden="true" />
      <div className="agent-toast-body">
        <p className="agent-toast-headline">
          <T3Glyph className="agent-toast-glyph" />
          <span>{alert.headline}</span>
          {alert.source ? <span className="agent-toast-source">{alert.source}</span> : null}
        </p>
        <strong>{alert.title}</strong>
        {alert.detail ? <small>{alert.detail}</small> : null}
      </div>
    </aside>
  );
}
