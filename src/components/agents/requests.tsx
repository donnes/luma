import { useState, type ReactNode } from 'react';
import { Check, ShieldCheck, X } from 'lucide-react';
import type { PendingApproval, PendingQuestion } from '../../agents/model';
import type { ApprovalDecision, UserInputQuestion } from '../../agents/types';
import { useTranslation, type MessageKey } from '../../i18n';

const decisionLabels: Record<ApprovalDecision, MessageKey> = {
  accept: 'agentApprove',
  acceptForSession: 'agentAllowSession',
  acceptAlways: 'agentAllowAlways',
  decline: 'agentDeny',
  cancel: 'agentDeny',
};

const decisionIcons: Partial<Record<ApprovalDecision, ReactNode>> = {
  accept: <Check />,
  acceptForSession: <ShieldCheck />,
  acceptAlways: <ShieldCheck />,
  decline: <X />,
};

export function Pill({
  id,
  icon,
  label,
  primary,
  disabled,
  onClick,
}: {
  id: string;
  icon?: ReactNode;
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`pill${primary ? ' pill-primary' : ''}`}
      data-focusable={id}
      data-primary={primary || undefined}
      disabled={disabled}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') event.currentTarget.focus({ preventScroll: true });
      }}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function ApprovalPills({
  approval,
  busy,
  onDecide,
}: {
  approval: PendingApproval;
  busy: boolean;
  onDecide: (decision: ApprovalDecision) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {approval.options.map((option, index) => (
        <Pill
          key={option.decision}
          id={`agent-decision-${option.decision}`}
          primary={index === 0}
          disabled={busy}
          icon={decisionIcons[option.decision]}
          label={t(decisionLabels[option.decision])}
          onClick={() => onDecide(option.decision)}
        />
      ))}
    </>
  );
}

export const answerValue = (option: UserInputQuestion['options'][number]) =>
  option.value ?? option.label;

/** True when the question can be answered with a single press from the Spotlight. */
export const isQuickQuestion = (question: PendingQuestion) =>
  question.questions.length === 1 && !question.questions[0].multiSelect;

export function QuickAnswerPills({
  question,
  busy,
  onAnswer,
}: {
  question: PendingQuestion;
  busy: boolean;
  onAnswer: (answers: Record<string, string>) => void;
}) {
  const [only] = question.questions;
  return (
    <>
      {only.options.map((option, index) => (
        <Pill
          key={option.label}
          id={`agent-answer-${index}`}
          primary={index === 0}
          disabled={busy}
          label={option.label}
          onClick={() => onAnswer({ [only.id]: answerValue(option) })}
        />
      ))}
    </>
  );
}

/** Every question with its options; multi-select questions toggle, then Submit. */
export function QuestionForm({
  question,
  busy,
  onAnswer,
}: {
  question: PendingQuestion;
  busy: boolean;
  onAnswer: (answers: Record<string, string | string[]>) => void;
}) {
  const { t } = useTranslation();
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const complete = question.questions.every((item) => answers[item.id]?.length);
  return (
    <div className="question-form">
      {question.questions.map((item) => (
        <fieldset key={item.id} className="question">
          <legend>
            <span className="eyebrow">{item.header}</span>
            <strong>{item.question}</strong>
          </legend>
          <div className="pills">
            {item.options.map((option, index) => {
              const value = answerValue(option);
              const selected = answers[item.id]?.includes(value) ?? false;
              return (
                <button
                  key={option.label}
                  className={`pill${selected ? ' pill-selected' : ''}`}
                  data-focusable={`question-${item.id}-${index}`}
                  aria-pressed={selected}
                  title={option.description}
                  disabled={busy}
                  onClick={() =>
                    setAnswers((current) => {
                      const previous = current[item.id] ?? [];
                      const next = item.multiSelect
                        ? selected
                          ? previous.filter((entry) => entry !== value)
                          : [...previous, value]
                        : [value];
                      return { ...current, [item.id]: next };
                    })
                  }
                >
                  {selected ? <Check /> : null}
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}
      <div className="pills">
        <Pill
          id="question-submit"
          primary
          disabled={busy || !complete}
          icon={<Check />}
          label={t('agentSubmit')}
          onClick={() =>
            onAnswer(
              Object.fromEntries(
                question.questions.map((item) => [
                  item.id,
                  item.multiSelect ? answers[item.id] : answers[item.id][0],
                ]),
              ),
            )
          }
        />
      </div>
    </div>
  );
}
