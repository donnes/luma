import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import { ArrowUpRight, Check, LoaderCircle, MessageCircle, Square, WifiOff } from 'lucide-react';
import {
  agentStatus,
  isWorking,
  lastAssistantText,
  modelLabel,
  needsYou,
  pendingRequest,
  recentSteps,
  summary,
  type Agent,
  type ThreadDetail,
} from '../../agents/model';
import { useAgents } from '../../agents/use-agents';
import { canOpenT3Code, openT3Code, threadPath } from '../../agents/web-client';
import type { ApprovalDecision, ThreadShell } from '../../agents/types';
import { useTranslation } from '../../i18n';
import { Conversation } from './conversation';
import { PairingBox } from './pairing-box';
import {
  ProjectMark,
  RequestSummary,
  StatusIndicator,
  requestLabels,
  statusLabels,
  useAgentActions,
  StepText,
} from './parts';
import { ReplyDialog } from './reply-dialog';
import { elapsed } from './format';
import { ApprovalPills, isQuickQuestion, Pill, QuickAnswerPills } from './requests';

const focusPrimary = () =>
  requestAnimationFrame(() =>
    document
      .querySelector<HTMLElement>('main [data-primary]:not([disabled]), main .spotlight .pill')
      ?.focus({ preventScroll: true }),
  );

interface Props {
  conversation: string | null;
  onConversation: (threadId: string | null) => void;
  backRef: MutableRefObject<(() => boolean) | null>;
  onPaired: () => void;
  notify: (text: string, error?: boolean) => void;
}

export function AgentsPage({ conversation, onConversation, backRef, onPaired, notify }: Props) {
  const { t } = useTranslation();
  const { state, agents, connection } = useAgents();
  const [selected, setSelected] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<ThreadShell | null>(null);
  const current = agents.find((agent) => agent.thread.id === selected) ?? agents[0] ?? null;
  const focusedThread = conversation ?? current?.thread.id ?? null;
  // Pin the spotlight to its agent; otherwise it would follow whichever card
  // the shelf's order puts first as agents change status. Adjusting state
  // while rendering re-renders before anything reaches the screen.
  const currentId = current?.thread.id ?? null;
  if (currentId && currentId !== selected) setSelected(currentId);

  useEffect(() => connection.focus(focusedThread), [connection, focusedThread]);
  useEffect(() => () => connection.focus(null), [connection]);

  useLayoutEffect(() => {
    backRef.current = () => {
      if (replyTo) {
        setReplyTo(null);
        return true;
      }
      if (conversation) {
        const id = conversation;
        onConversation(null);
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLElement>(`[data-focusable="agent-${CSS.escape(id)}"]`)
            ?.focus({ preventScroll: true }),
        );
        return true;
      }
      return false;
    };
    return () => {
      backRef.current = null;
    };
  });

  // Land on the spotlight's first action once there's something to act on.
  const hasAgent = !!current;
  useLayoutEffect(() => {
    if (
      hasAgent &&
      !conversation &&
      !document.querySelector('main')?.contains(document.activeElement)
    )
      focusPrimary();
  }, [hasAgent, conversation]);

  const detail =
    state.detail?.threadId === focusedThread && state.detail.ready ? state.detail : null;

  // Where the shell can host it, the full T3 Code app shows a thread's
  // conversation; elsewhere Luma's own conversation view does.
  const openT3 = (path?: string) =>
    void openT3Code(path).catch(() => notify(t('agentsWebFailed'), true));
  const openThread = (threadId: string) =>
    canOpenT3Code() && state.pairing
      ? openT3(threadPath(state.pairing.environmentId, threadId))
      : onConversation(threadId);

  if (!state.pairing || state.status === 'expired') return <PairingBox onPaired={onPaired} />;
  if (!state.shell.ready)
    return state.status === 'offline' ? (
      <AgentsMessage
        icon={<WifiOff />}
        title={t('agentsOfflineTitle')}
        body={t('agentsOfflineBody', { server: state.pairing.label || 'T3 Code' })}
        action={t('retry')}
        onAction={() => connection.resume()}
      />
    ) : (
      <div className="agents-loading" role="status">
        <LoaderCircle className="spin" />
        {t('agentsConnecting', { server: state.pairing.label || 'T3 Code' })}
      </div>
    );

  const conversationThread = conversation ? state.shell.threads.get(conversation) : undefined;
  if (conversation && conversationThread)
    return (
      <>
        <Conversation
          agent={{
            thread: conversationThread,
            project: state.shell.projects.get(conversationThread.projectId),
            status: agentStatus(conversationThread),
          }}
          detail={detail}
          onReply={() => setReplyTo(conversationThread)}
          notify={notify}
        />
        {replyTo ? (
          <ReplyDialog thread={replyTo} onClose={() => setReplyTo(null)} notify={notify} />
        ) : null}
      </>
    );

  if (!current)
    return (
      <AgentsMessage
        icon={<Check />}
        title={t('agentsQuietTitle')}
        body={t('agentsQuietBody')}
        {...(canOpenT3Code() ? { action: t('agentsOpenT3'), onAction: () => openT3() } : {})}
      />
    );

  return (
    <div className="agents-page">
      <Spotlight
        key={current.thread.id}
        agent={current}
        detail={detail}
        onOpen={() => openThread(current.thread.id)}
        onReply={() => setReplyTo(current.thread)}
        notify={notify}
        onResolved={() => {
          const next = agents.find(
            (agent) => needsYou(agent.status) && agent.thread.id !== current.thread.id,
          );
          if (next) {
            setSelected(next.thread.id);
            focusPrimary();
          }
        }}
      />
      <section className="agents-shelf" aria-labelledby="agents-heading">
        <div className="section-heading">
          <h2 id="agents-heading">
            {t('agents')}
            <span className="agents-count">{t('agentsActive', { count: agents.length })}</span>
          </h2>
        </div>
        <div className="agents-row">
          {agents.map((agent) => (
            <AgentCard
              key={agent.thread.id}
              agent={agent}
              selected={agent.thread.id === current.thread.id}
              onFocus={() => setSelected(agent.thread.id)}
              onOpen={() => openThread(agent.thread.id)}
            />
          ))}
        </div>
      </section>
      {replyTo ? (
        <ReplyDialog thread={replyTo} onClose={() => setReplyTo(null)} notify={notify} />
      ) : null}
    </div>
  );
}

function AgentsMessage({
  icon,
  title,
  body,
  action,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <section className="agents-message">
      {icon}
      <h1>{title}</h1>
      <p>{body}</p>
      <div className="pills">
        {action && onAction ? (
          <button className="pill pill-primary" data-focusable="agents-action" onClick={onAction}>
            {action}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function Eyebrow({ agent }: { agent: Agent }) {
  const { t, locale } = useTranslation();
  const since =
    needsYou(agent.status) && agent.thread.pendingRuntimeRequest
      ? agent.thread.pendingRuntimeRequest.createdAt
      : agent.thread.updatedAt;
  return (
    <div className={`eyebrow agent-eyebrow status-${agent.status}`}>
      <StatusIndicator status={agent.status} />
      {[
        t(statusLabels[agent.status]),
        agent.project?.title,
        modelLabel(agent.thread.modelSelection?.model),
        elapsed(since, locale),
      ]
        .filter(Boolean)
        .join(' · ')}
    </div>
  );
}

function Spotlight({
  agent,
  detail,
  onOpen,
  onReply,
  onResolved,
  notify,
}: {
  agent: Agent;
  detail: ThreadDetail | null;
  onOpen: () => void;
  onReply: () => void;
  onResolved: () => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const { t } = useTranslation();
  const { busy, run, connection } = useAgentActions(agent.thread.id);
  const { thread, status } = agent;
  const pending = detail ? pendingRequest(detail) : null;
  const steps = detail && isWorking(status) ? recentSteps(detail) : [];
  const message = thread.latestVisibleMessage;
  const said =
    status === 'error' && thread.lastError
      ? thread.lastError
      : summary(
          message?.role === 'assistant' ? message.text : detail ? lastAssistantText(detail) : '',
        );
  // Details arrive a moment after the spotlight; when a request shows up, its
  // first action takes focus so OK answers it instead of whatever was primary.
  const section = useRef<HTMLElement>(null);
  const requestId = pending?.requestId;
  // Answering a request removes the focused pill; keep the remote anchored.
  useLayoutEffect(() => {
    if (document.activeElement === document.body && !document.querySelector('[role="dialog"]'))
      section.current
        ?.querySelector<HTMLElement>('[data-primary]:not([disabled]), .pill:not([disabled])')
        ?.focus({ preventScroll: true });
  });
  useLayoutEffect(() => {
    if (requestId && section.current?.contains(document.activeElement))
      section.current
        .querySelector<HTMLElement>('[data-primary]:not([disabled])')
        ?.focus({ preventScroll: true });
  }, [requestId]);
  const onError = (text: string) => notify(text, true);
  const decide = async (decision: ApprovalDecision) => {
    if (pending?.kind !== 'approval') return;
    if (await run(() => connection.respond(thread.id, pending.requestId, decision), onError))
      onResolved();
  };
  const answer = async (answers: Record<string, string>) => {
    if (pending?.kind !== 'input') return;
    if (await run(() => connection.answer(thread.id, pending.requestId, answers), onError))
      onResolved();
  };

  return (
    <section ref={section} className={`spotlight${needsYou(status) ? ' has-request' : ''}`}>
      <Eyebrow agent={agent} />
      <h1 className="spotlight-title">{thread.title}</h1>
      {/* Text that streams in lives in a fixed slot, so the actions never move. */}
      <div className="spotlight-body">
        {said ? <p className="spotlight-said">{said}</p> : null}
        {needsYou(status) ? <RequestSummary pending={pending} agent={agent} /> : null}
        {steps.length ? (
          <ul className="agent-steps">
            {steps.map((step, index) => (
              <li key={step.id} className={index === steps.length - 1 ? 'is-latest' : ''}>
                {step.status === 'running' || step.status === 'pending' ? (
                  <span className="agent-spinner" aria-hidden="true" />
                ) : (
                  <Check aria-hidden="true" />
                )}
                <StepText step={step} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="pills">
        {pending?.kind === 'approval' ? (
          <ApprovalPills
            approval={pending}
            busy={busy}
            onDecide={(decision) => void decide(decision)}
          />
        ) : pending?.kind === 'input' && isQuickQuestion(pending) ? (
          <QuickAnswerPills
            question={pending}
            busy={busy}
            onAnswer={(answers) => void answer(answers)}
          />
        ) : pending?.kind === 'input' ? (
          <Pill
            id="agent-answer"
            primary
            icon={<MessageCircle />}
            label={t('agentAnswer')}
            onClick={onOpen}
          />
        ) : null}
        <Pill
          id="agent-open"
          primary={!pending}
          icon={<ArrowUpRight />}
          label={t('agentOpen')}
          onClick={onOpen}
        />
        <Pill id="agent-reply" icon={<MessageCircle />} label={t('agentReply')} onClick={onReply} />
        {isWorking(status) ? (
          <Pill
            id="agent-stop"
            icon={<Square />}
            label={t('agentStop')}
            disabled={busy}
            onClick={() => void run(() => connection.stop(thread.id), onError)}
          />
        ) : null}
      </div>
    </section>
  );
}

function AgentCard({
  agent,
  selected,
  onFocus,
  onOpen,
}: {
  agent: Agent;
  selected: boolean;
  onFocus: () => void;
  onOpen: () => void;
}) {
  const { t, locale } = useTranslation();
  const { thread, status } = agent;
  const detail = needsYou(status)
    ? t(
        thread.pendingRuntimeRequest?.kind === 'user_input'
          ? 'agentAsked'
          : (requestLabels[thread.pendingRuntimeRequest?.kind ?? 'permission'] ??
              'agentWantsPermission'),
      )
    : elapsed(thread.updatedAt, locale);
  return (
    <button
      className={`agent-card${needsYou(status) ? ' needs-you' : ''}${selected ? ' is-selected' : ''}`}
      data-focusable={`agent-${thread.id}`}
      aria-label={`${thread.title}, ${t(statusLabels[status])}`}
      onFocus={onFocus}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') event.currentTarget.focus({ preventScroll: true });
      }}
      onClick={onOpen}
    >
      <span className="agent-card-top">
        <span className="agent-project">
          <ProjectMark agent={agent} />
          <span>{agent.project?.title}</span>
        </span>
        <span className={`agent-status status-${status}`}>
          <StatusIndicator status={status} />
          {t(statusLabels[status])}
        </span>
      </span>
      <span className="agent-card-body">
        <strong>{thread.title}</strong>
        <small>{detail}</small>
      </span>
    </button>
  );
}
