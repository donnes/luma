import { useLayoutEffect, useMemo, useRef } from 'react';
import { Check, ChevronLeft, LoaderCircle, MessageCircle, Square, X } from 'lucide-react';
import {
  isWorking,
  modelLabel,
  needsYou,
  orderedItems,
  pendingRequest,
  plainText,
  stepOf,
  type Agent,
  type Step,
  type ThreadDetail,
} from '../../agents/model';
import { useTranslation } from '../../i18n';
import { ApprovalPills, Pill, QuestionForm } from './requests';
import { RequestSummary, StatusIndicator, statusLabels, useAgentActions, StepText } from './parts';

const MAX_ENTRIES = 80;
const STEPS_SHOWN = 4;

type Entry =
  | { kind: 'user' | 'assistant'; id: string; text: string; streaming?: boolean }
  | { kind: 'steps'; id: string; steps: Step[] };

// Consecutive tool calls collapse into one quiet block between messages.
function entries(detail: ThreadDetail): Entry[] {
  const result: Entry[] = [];
  for (const item of orderedItems(detail)) {
    if (item.type === 'user_message' && item.text.trim())
      result.push({ kind: 'user', id: item.id, text: plainText(item.text) });
    else if (item.type === 'assistant_message' && item.text.trim())
      result.push({
        kind: 'assistant',
        id: item.id,
        text: plainText(item.text),
        streaming: item.streaming,
      });
    else {
      const step = stepOf(item);
      if (!step) continue;
      const last = result.at(-1);
      if (last?.kind === 'steps') last.steps.push(step);
      else result.push({ kind: 'steps', id: item.id, steps: [step] });
    }
  }
  return result.slice(-MAX_ENTRIES);
}

function Steps({ steps }: { steps: Step[] }) {
  const { t } = useTranslation();
  const hidden = steps.length - STEPS_SHOWN;
  return (
    <ul className="conversation-steps">
      {hidden > 0 ? <li className="steps-more">{t('agentMoreSteps', { count: hidden })}</li> : null}
      {steps.slice(-STEPS_SHOWN).map((step) => (
        <li key={step.id}>
          {step.status === 'running' || step.status === 'pending' ? (
            <span className="agent-spinner" aria-hidden="true" />
          ) : step.status === 'failed' ? (
            <X aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          <StepText step={step} />
        </li>
      ))}
    </ul>
  );
}

export function Conversation({
  agent,
  detail,
  onReply,
  notify,
}: {
  agent: Agent;
  detail: ThreadDetail | null;
  onReply: () => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const { t } = useTranslation();
  const { busy, run, connection } = useAgentActions(agent.thread.id);
  const history = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const list = useMemo(() => (detail ? entries(detail) : []), [detail]);
  const pending = detail ? pendingRequest(detail) : null;
  const { thread, status } = agent;
  const onError = (text: string) => notify(text, true);

  // Follow new messages while the reader is at the bottom, like a chat.
  useLayoutEffect(() => {
    const node = history.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [list]);

  // Answering a request removes the focused pill; fall back to the reply bar.
  useLayoutEffect(() => {
    if (document.activeElement === document.body && !document.querySelector('[role="dialog"]'))
      document.querySelector<HTMLElement>('.conversation .compose')?.focus({ preventScroll: true });
  });

  // A request arriving while you read moves focus to its first action.
  const requestId = pending?.requestId;
  useLayoutEffect(() => {
    if (requestId)
      document
        .querySelector<HTMLElement>('.conversation [data-primary]:not([disabled])')
        ?.focus({ preventScroll: true });
  }, [requestId]);

  useLayoutEffect(() => {
    if (!detail) return;
    document
      .querySelector<HTMLElement>(
        '.conversation [data-primary]:not([disabled]), .conversation .compose',
      )
      ?.focus({ preventScroll: true });
    // Only when the conversation first has content.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [!!detail]);

  return (
    <div className="conversation">
      <div className="conversation-crumb">
        <ChevronLeft />
        {t('agents')} <span>/</span> <b>{agent.project?.title}</b>
      </div>
      <section className="conversation-sheet" aria-labelledby="conversation-title">
        <div className={`eyebrow agent-eyebrow status-${status}`}>
          <StatusIndicator status={status} />
          {[
            t(statusLabels[status]),
            agent.project?.title,
            modelLabel(thread.modelSelection?.model),
            thread.branch,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
        <h1 id="conversation-title">{thread.title}</h1>
        {/* A scrollable region has to take focus for the remote to scroll it. */}
        {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <div
          ref={history}
          className="conversation-history"
          role="log"
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          data-focusable="conversation-history"
          aria-label={t('agentHistory')}
          onScroll={(event) => {
            const node = event.currentTarget;
            pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
          }}
          onKeyDown={(event) => {
            // Up and Down read through the history; at either end they move focus on.
            const node = event.currentTarget;
            const step = node.clientHeight * 0.45;
            if (event.key === 'ArrowUp' && node.scrollTop > 0) {
              event.preventDefault();
              event.stopPropagation();
              node.scrollBy({ top: -step });
            } else if (
              event.key === 'ArrowDown' &&
              node.scrollTop + node.clientHeight < node.scrollHeight - 2
            ) {
              event.preventDefault();
              event.stopPropagation();
              node.scrollBy({ top: step });
            }
          }}
        >
          {!detail ? (
            <div className="conversation-loading">
              <LoaderCircle className="spin" />
            </div>
          ) : (
            list.map((entry) =>
              entry.kind === 'steps' ? (
                <Steps key={entry.id} steps={entry.steps} />
              ) : (
                <div key={entry.id} className={`bubble bubble-${entry.kind}`}>
                  {entry.text}
                  {entry.streaming ? <span className="agent-spinner" aria-hidden="true" /> : null}
                </div>
              ),
            )
          )}
        </div>
        {needsYou(status) && pending ? (
          <div className="conversation-request">
            <RequestSummary pending={pending} agent={agent} />
            {pending.kind === 'approval' ? (
              <div className="pills">
                <ApprovalPills
                  approval={pending}
                  busy={busy}
                  onDecide={(decision) =>
                    void run(
                      () => connection.respond(thread.id, pending.requestId, decision),
                      onError,
                    )
                  }
                />
              </div>
            ) : (
              <QuestionForm
                question={pending}
                busy={busy}
                onAnswer={(answers) =>
                  void run(() => connection.answer(thread.id, pending.requestId, answers), onError)
                }
              />
            )}
          </div>
        ) : null}
        <div className="compose-row">
          <button className="compose" data-focusable="agent-compose" onClick={onReply}>
            <MessageCircle />
            <span>{t('agentReplyPrompt')}</span>
          </button>
          {isWorking(status) ? (
            <Pill
              id="conversation-stop"
              icon={<Square />}
              label={t('agentStop')}
              disabled={busy}
              onClick={() => void run(() => connection.stop(thread.id), onError)}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}
