import { answerCommand, decideCommand, messageCommand } from '../../../src/agents/commands.ts';
import {
  agentStatus,
  answerValue,
  needsYou,
  pendingRequest,
  shelfAgents,
  summary,
  type Agent,
  type Shell,
} from '../../../src/agents/model.ts';
import type { ApprovalDecision, ThreadShell } from '../../../src/agents/types.ts';
import { RpcError } from '../../../src/agents/rpc.ts';
import type { T3Session } from './t3.ts';

// The only things the assistant can do. Each tool returns JSON for the model
// to phrase; `{error}` results are for it to recover from, like asking which
// thread Donald meant.

const nullable = (type: string, description: string) => ({ type: [type, 'null'], description });

export const toolDefinitions = [
  {
    type: 'function',
    name: 'get_status',
    description:
      "Summarizes Donald's T3 Code agents: which need him (approvals and questions, with their details), which are working, which finished or failed recently. Returns thread ids for the other tools.",
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    type: 'function',
    name: 'reply_to_thread',
    description: "Sends Donald's message to a T3 Code thread, like typing it in the composer.",
    parameters: {
      type: 'object',
      properties: {
        thread: {
          type: 'string',
          description: 'Thread id from get_status, or words from its title.',
        },
        message: { type: 'string', description: "The message, in Donald's words." },
      },
      required: ['thread', 'message'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'answer_request',
    description:
      'Answers the pending approval or question in a thread. Approving needs Donald to confirm on his next turn: the result says so, and confirm_action carries it out.',
    parameters: {
      type: 'object',
      properties: {
        thread: {
          type: 'string',
          description: 'Thread id from get_status, or words from its title.',
        },
        decision: {
          ...nullable('string', 'For approvals. Null for questions.'),
          enum: ['accept', 'acceptForSession', 'decline', null],
        },
        answers: {
          type: ['array', 'null'],
          items: { type: 'string' },
          description:
            'For questions: one answer per question, in order, using an option label where one fits. Null for approvals.',
        },
      },
      required: ['thread', 'decision', 'answers'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'confirm_action',
    description:
      'Carries out the approval Donald was asked to confirm on his previous turn. Only call it when he clearly says yes.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
];

/** An approval waiting for Donald's yes. */
export interface PendingAction {
  threadId: string;
  requestId: string;
  decision: ApprovalDecision;
  title: string;
}

export interface ToolContext {
  t3: T3Session;
  /** Set by the previous request, if it asked for confirmation. */
  confirmable: PendingAction | null;
  /** What this request asks Donald to confirm next. */
  proposed: PendingAction | null;
}

type Result = Record<string, unknown>;

const projectTitle = (shell: Shell, thread: ThreadShell) =>
  shell.projects.get(thread.projectId)?.title ?? '';

const brief = (shell: Shell, thread: ThreadShell) => ({
  id: thread.id,
  title: thread.title,
  project: projectTitle(shell, thread),
});

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Finds the thread Donald named: an exact id or title first, then titles (with
 * their project) containing every word he said. Agents on the shelf win over
 * older threads, since those are the ones he's likely talking about.
 */
export function findThread(
  shell: Shell,
  name: string,
  only: (thread: ThreadShell) => boolean = () => true,
): { thread: ThreadShell } | { error: string } {
  const live = [...shell.threads.values()].filter(
    (thread) =>
      !thread.archivedAt &&
      !thread.deletedAt &&
      thread.lineage?.relationshipToParent !== 'subagent' &&
      only(thread),
  );
  const exact = live.filter(
    (thread) => thread.id === name || thread.title.toLowerCase() === name.trim().toLowerCase(),
  );
  if (exact.length === 1) return { thread: exact[0] };
  const wanted = words(name);
  const matches = live.filter((thread) => {
    const have = new Set(words(`${thread.title} ${projectTitle(shell, thread)}`));
    return wanted.length > 0 && wanted.every((word) => have.has(word));
  });
  const shelf = new Set(shelfAgents(shell).map((agent) => agent.thread.id));
  const onShelf = matches.filter((thread) => shelf.has(thread.id));
  const candidates = onShelf.length ? onShelf : matches;
  if (candidates.length === 1) return { thread: candidates[0] };
  if (!candidates.length) return { error: `No thread matches "${name}".` };
  return {
    error: `Several threads match "${name}": ${candidates
      .slice(0, 4)
      .map((thread) => thread.title)
      .join('; ')}.`,
  };
}

async function status(context: ToolContext): Promise<Result> {
  const shell = await context.t3.shell();
  const agents = shelfAgents(shell);
  const of = (match: (agent: Agent) => boolean) => agents.filter(match);
  const needs = await Promise.all(
    of((agent) => needsYou(agent.status)).map(async (agent) => {
      const request = await context.t3
        .thread(agent.thread.id)
        .then(pendingRequest)
        .catch(() => null);
      return {
        ...brief(shell, agent.thread),
        waitingFor: agent.status === 'approval' ? 'approval' : 'answer',
        request:
          request?.kind === 'approval'
            ? { kind: request.requestKind, detail: summary(request.detail, 200) }
            : request?.kind === 'input'
              ? request.questions.map((question) => ({
                  question: question.question,
                  options: question.options.map((option) => option.label),
                }))
              : null,
      };
    }),
  );
  return {
    needsYou: needs,
    working: of((agent) => agent.status === 'running' || agent.status === 'starting').map((agent) =>
      brief(shell, agent.thread),
    ),
    done: of((agent) => agent.status === 'done').map((agent) => ({
      ...brief(shell, agent.thread),
      lastMessage: summary(agent.thread.latestVisibleMessage?.text ?? '', 160),
    })),
    failed: of((agent) => agent.status === 'error').map((agent) => ({
      ...brief(shell, agent.thread),
      error: summary(agent.thread.lastError ?? '', 160),
    })),
  };
}

async function reply(context: ToolContext, args: { thread: string; message: string }) {
  const message = args.message.trim();
  if (!message) return { error: 'The message is empty.' };
  const found = findThread(await context.t3.shell(), args.thread);
  if ('error' in found) return found;
  await context.t3.dispatch(messageCommand(found.thread.id, message));
  return { sent: true, thread: found.thread.title };
}

const loose = (text: string) => words(text).join(' ');

async function answer(
  context: ToolContext,
  args: { thread: string; decision: string | null; answers: string[] | null },
): Promise<Result> {
  const shell = await context.t3.shell();
  const found = findThread(shell, args.thread, (thread) => needsYou(agentStatus(thread)));
  if ('error' in found) return { error: `${found.error} Only threads waiting for Donald count.` };
  const { thread } = found;
  const request = pendingRequest(await context.t3.thread(thread.id));
  if (!request) return { error: `"${thread.title}" has nothing waiting for an answer.` };

  if (request.kind === 'approval') {
    const option = request.options.find((candidate) => candidate.decision === args.decision);
    if (!option)
      return {
        error: 'Pick one of these decisions.',
        decisions: request.options.map((candidate) => candidate.decision),
      };
    if (option.decision === 'decline' || option.decision === 'cancel') {
      await context.t3.dispatch(decideCommand(thread.id, request.requestId, option.decision));
      return { done: true, thread: thread.title, decision: option.decision };
    }
    context.proposed = {
      threadId: thread.id,
      requestId: request.requestId,
      decision: option.decision,
      title: thread.title,
    };
    return {
      needsConfirmation: true,
      thread: thread.title,
      decision: option.decision,
      request: { kind: request.requestKind, detail: summary(request.detail, 200) },
    };
  }

  const given = args.answers ?? [];
  if (given.length !== request.questions.length)
    return {
      error: `Give one answer per question, ${request.questions.length} in all.`,
      questions: request.questions.map((question) => ({
        question: question.question,
        options: question.options.map((option) => option.label),
      })),
    };
  const answers: Record<string, string | string[]> = {};
  for (const [index, question] of request.questions.entries()) {
    const said = loose(given[index]);
    const option = question.options.find(
      (candidate) => loose(candidate.label) === said || loose(answerValue(candidate)) === said,
    );
    if (!option && question.allowCustomAnswer === false)
      return {
        error: `"${given[index]}" isn't an option for "${question.question}".`,
        options: question.options.map((candidate) => candidate.label),
      };
    const value = option ? answerValue(option) : given[index].trim();
    answers[question.id] = question.multiSelect ? [value] : value;
  }
  await context.t3.dispatch(answerCommand(thread.id, request.requestId, answers));
  return { done: true, thread: thread.title };
}

async function confirm(context: ToolContext): Promise<Result> {
  const action = context.confirmable;
  if (!action)
    return {
      error:
        'Nothing is waiting for confirmation. Approvals are confirmed on the turn after Luma asks.',
    };
  context.confirmable = null;
  await context.t3.dispatch(decideCommand(action.threadId, action.requestId, action.decision));
  return { done: true, thread: action.title, decision: action.decision };
}

function call(context: ToolContext, name: string, args: Record<string, unknown>) {
  const text = (key: string) => {
    const value = args[key];
    return typeof value === 'string' ? value : '';
  };
  switch (name) {
    case 'get_status':
      return status(context);
    case 'reply_to_thread':
      return reply(context, { thread: text('thread'), message: text('message') });
    case 'answer_request':
      return answer(context, {
        thread: text('thread'),
        decision: text('decision') || null,
        answers: Array.isArray(args.answers) ? args.answers.map(String) : null,
      });
    case 'confirm_action':
      return confirm(context);
    default:
      return Promise.resolve({ error: `There is no tool called ${name}.` });
  }
}

/**
 * Runs one tool call. Bad arguments and commands T3 Code refuses come back as
 * `{error}`; losing T3 Code altogether throws `T3Unavailable`.
 */
export async function runTool(
  context: ToolContext,
  name: string,
  rawArgs: string,
): Promise<Result> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs || '{}');
  } catch {
    return { error: 'Arguments were not valid JSON.' };
  }
  try {
    return await call(context, name, args);
  } catch (error) {
    if (error instanceof RpcError) return { error: `T3 Code refused: ${error.message}` };
    throw error;
  }
}
