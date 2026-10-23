import { useEffect, useLayoutEffect, useRef } from 'react';
import { agentSince, isWorking, type Agent, type Inbox } from '../../agents/model';
import { useTranslation, type MessageKey } from '../../i18n';
import { T3Glyph } from './agents-mark';
import { elapsed } from './format';
import { statusLabels } from './parts';
import './inbox.css';

const groups: { key: keyof Inbox; label: MessageKey }[] = [
  { key: 'needsYou', label: 'agentNeedsYou' },
  { key: 'done', label: 'agentDone' },
  { key: 'working', label: 'agentWorking' },
];

// Takes everything as props and owns its styles, so it can render outside
// Luma's pages too. Arrow keys move through `data-focusable` rows inside the
// `data-focus-scope="dialog"` panel; Back closes it.
export function InboxPanel({
  inbox,
  source,
  onOpen,
  onClose,
}: {
  inbox: Inbox;
  /** Where the threads come from, such as the paired server's name. */
  source?: string;
  onOpen: (threadId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const panel = useRef<HTMLElement>(null);
  const shown = groups.filter((group) => inbox[group.key].length);

  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = panel.current;
    node?.querySelector<HTMLElement>('[data-focusable]')?.focus({ preventScroll: true });
    // Runs before React removes the panel, so focus goes back to where it was
    // instead of falling to the page and whatever claims it there.
    return () => {
      if (node?.contains(document.activeElement) && previous?.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, []);

  // Rows can come and go while the panel is open; keep the remote on one.
  useLayoutEffect(() => {
    if (!panel.current?.contains(document.activeElement))
      panel.current?.querySelector<HTMLElement>('[data-focusable]')?.focus({ preventScroll: true });
  });

  // Back belongs to the panel while it's open, ahead of the page behind it.
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' &&
        event.keyCode !== 461 &&
        !(event.key === 'Backspace' && !(event.target instanceof HTMLInputElement))
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) onClose();
    };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [onClose]);

  return (
    <section
      ref={panel}
      className="inbox"
      role="dialog"
      aria-modal="true"
      aria-labelledby="inbox-title"
      data-focus-scope="dialog"
    >
      <header className="inbox-header">
        <T3Glyph className="inbox-glyph" />
        <h2 id="inbox-title">{t('agentsInbox')}</h2>
        {source ? <span className="inbox-source">{source}</span> : null}
      </header>
      <div className="inbox-list">
        {shown.length ? (
          shown.map((group) => (
            <section key={group.key} className="inbox-group" aria-labelledby={`inbox-${group.key}`}>
              <h3 id={`inbox-${group.key}`}>{t(group.label)}</h3>
              <ul>
                {inbox[group.key].map((agent) => (
                  <InboxRow key={agent.thread.id} agent={agent} onOpen={onOpen} />
                ))}
              </ul>
            </section>
          ))
        ) : (
          <p className="inbox-empty">{t('agentsQuietTitle')}</p>
        )}
      </div>
    </section>
  );
}

function InboxRow({ agent, onOpen }: { agent: Agent; onOpen: (threadId: string) => void }) {
  const { t, locale } = useTranslation();
  const { thread, status } = agent;
  return (
    <li>
      <button
        className="inbox-row"
        data-focusable={`inbox-${thread.id}`}
        aria-label={`${thread.title}, ${t(statusLabels[status])}`}
        onFocus={(event) => {
          // The first row of a group brings its heading along.
          const row = event.currentTarget;
          const target = row.closest('li')?.previousElementSibling ? row : row.closest('section');
          target?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') event.currentTarget.focus({ preventScroll: true });
        }}
        onClick={() => onOpen(thread.id)}
      >
        {isWorking(status) ? (
          <span className="inbox-spinner" aria-hidden="true" />
        ) : (
          <span className={`inbox-dot inbox-dot-${status}`} aria-hidden="true" />
        )}
        <span className="inbox-text">
          <strong>{thread.title}</strong>
          {agent.project ? <small>{agent.project.title}</small> : null}
        </span>
        <time dateTime={agentSince(agent)}>{elapsed(agentSince(agent), locale)}</time>
      </button>
    </li>
  );
}
