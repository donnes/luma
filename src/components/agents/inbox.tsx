import { useEffect, useLayoutEffect, useRef } from 'react';
import { agentSince, isWorking, type Agent, type Inbox } from '../../agents/model';
import { useAgents } from '../../agents/use-agents';
import { canOpenT3Code, openT3Code, threadPath } from '../../agents/web-client';
import { useTranslation, type MessageKey } from '../../i18n';
import { isMenuKey } from '../../navigation';
import { T3Glyph } from './agents-mark';
import { elapsed } from './format';
import { statusLabels } from './parts';
import './inbox.css';

const groups: { key: keyof Inbox; label: MessageKey }[] = [
  { key: 'needsYou', label: 'agentNeedsYou' },
  { key: 'done', label: 'agentDone' },
  { key: 'working', label: 'agentWorking' },
];

/**
 * The inbox the Menu button brings up over any page: the paired server's
 * threads, or a line on why there are none and where to fix that. A thread
 * opens in T3 Code's web app where the shell hosts it, otherwise in Luma's
 * own conversation view.
 */
export function AgentsInbox({
  onConversation,
  onClose,
  notify,
}: {
  onConversation: (threadId: string) => void;
  onClose: () => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const { t } = useTranslation();
  const { state, inbox } = useAgents();
  const { pairing } = state;
  const server = pairing?.label || 'T3 Code';
  const notice: Notice | undefined = !pairing
    ? { title: t('agentsPairTitle'), body: t('agentsInboxPair') }
    : state.status === 'expired'
      ? { title: t('agentsExpiredTitle'), body: t('agentsInboxPair') }
      : state.shell.ready
        ? undefined
        : state.status === 'offline'
          ? { title: t('agentsOfflineTitle'), body: t('agentsInboxOffline') }
          : { title: t('agentsConnecting', { server }) };
  return (
    <div
      className="inbox-layer"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <InboxPanel
        inbox={inbox}
        source={pairing?.label || undefined}
        notice={notice}
        onOpen={(threadId) => {
          onClose();
          if (canOpenT3Code() && pairing)
            void openT3Code(threadPath(pairing.environmentId, threadId)).catch(() =>
              notify(t('agentsWebFailed'), true),
            );
          else onConversation(threadId);
        }}
        onClose={onClose}
      />
    </div>
  );
}

interface Notice {
  title: string;
  body?: string;
}

// Takes everything as props, owns its styles and handles the remote itself,
// so it works outside Luma's pages too: Up and Down move through the rows in
// list order, OK opens one and Back or Menu closes the panel.
export function InboxPanel({
  inbox,
  source,
  notice,
  onOpen,
  onClose,
}: {
  inbox: Inbox;
  /** Where the threads come from, such as the paired server's name. */
  source?: string;
  /** Shown instead of the threads, such as while there's no connection. */
  notice?: Notice;
  onOpen: (threadId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const panel = useRef<HTMLElement>(null);
  // The focused row, so focus can stay with it, or near it, as rows come and go.
  const focused = useRef({ id: '', index: 0 });
  const shown = groups.filter((group) => inbox[group.key].length);
  const rows = () => [...(panel.current?.querySelectorAll<HTMLButtonElement>('.inbox-row') ?? [])];

  // Registered before the first row takes focus, so that focus is tracked too.
  useLayoutEffect(() => {
    const node = panel.current;
    if (!node) return;
    const track = (event: FocusEvent) => {
      const list = rows();
      const index = list.findIndex((row) => row === event.target);
      if (index >= 0) focused.current = { id: list[index].dataset.focusable ?? '', index };
    };
    // Only a pointer that moves picks a row. Rows scrolling under a resting
    // pointer, as D-pad navigation does, must not take focus from the remote.
    let last = { x: -1, y: -1 };
    const hover = (event: PointerEvent) => {
      const { clientX: x, clientY: y } = event;
      if (event.pointerType !== 'mouse' || (x === last.x && y === last.y)) return;
      last = { x, y };
      if (event.target instanceof Element)
        event.target.closest<HTMLElement>('.inbox-row')?.focus({ preventScroll: true });
    };
    node.addEventListener('focusin', track);
    node.addEventListener('pointermove', hover);
    return () => {
      node.removeEventListener('focusin', track);
      node.removeEventListener('pointermove', hover);
    };
  }, []);

  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    rows()[0]?.focus({ preventScroll: true });
    // Runs before React removes the panel, so focus goes back to where it was
    // instead of falling to the page and whatever claims it there.
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  // Live updates can move or remove the focused row: follow it, or land on the
  // row that took its place, or on the panel itself once the list is empty.
  useLayoutEffect(() => {
    const node = panel.current;
    if (!node || node.contains(document.activeElement)) return;
    const list = rows();
    (
      list.find((row) => row.dataset.focusable === focused.current.id) ??
      list[Math.min(focused.current.index, list.length - 1)] ??
      node
    ).focus({ preventScroll: true });
  });

  // The remote belongs to the panel while it's open, ahead of the page behind it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const list = rows();
      const index = list.findIndex((row) => row === document.activeElement);
      if (
        event.key === 'Escape' ||
        event.keyCode === 461 ||
        (event.key === 'Backspace' && !(event.target instanceof HTMLInputElement)) ||
        isMenuKey(event)
      ) {
        if (!event.repeat) onClose();
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const next = list[Math.max(0, index + (event.key === 'ArrowUp' ? -1 : 1))];
        next?.focus({ preventScroll: true });
      } else if (event.key === 'Enter' || event.keyCode === 13) {
        if (!event.repeat) list[index]?.click();
      } else if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <section
      ref={panel}
      className="inbox"
      role="dialog"
      aria-modal="true"
      aria-labelledby="inbox-title"
      data-focus-scope="dialog"
      tabIndex={-1}
    >
      <header className="inbox-header">
        <T3Glyph className="inbox-glyph" />
        <h2 id="inbox-title">{t('agentsInbox')}</h2>
        {source ? <span className="inbox-source">{source}</span> : null}
      </header>
      <div className="inbox-list">
        {notice ? (
          <div className="inbox-notice" role="status">
            <p>{notice.title}</p>
            {notice.body ? <p>{notice.body}</p> : null}
          </div>
        ) : shown.length ? (
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
          // The first row of a group brings its heading along. Scrolling the
          // row last keeps it visible when the group is taller than the list.
          const row = event.currentTarget;
          if (!row.closest('li')?.previousElementSibling) {
            row
              .closest('section')
              ?.querySelector('h3')
              ?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
          }
          row.scrollIntoView({ block: 'nearest', behavior: 'instant' });
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
