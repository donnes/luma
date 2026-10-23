import {
  answerCommand,
  decideCommand,
  messageCommand,
  type Command,
} from '../../../src/agents/commands.ts';
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
import type { ThreadShell } from '../../../src/agents/types.ts';
import { RpcError } from '../../../src/agents/rpc.ts';
import type { T3Session } from './t3.ts';

// The only things the assistant can do. Each tool returns JSON for the model
// to phrase; `{error}` results are for it to recover from, like asking which
// thread Donald meant.
//
// Thread titles, messages and requests come from coding agents and can carry
// instructions meant for the model. So once the model has seen any of them,
// writes wait for Donald's spoken yes. The model never decides that he said
// yes: the assistant checks his next words itself.
//
// Approvals can't be given by voice at all. A request's prompt is the agent's
// reason when it gave one, not the command, so Donald could approve a command
// he never heard. He approves in T3 Code, where he sees the command.

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
      "Answers the pending question in a thread, or denies its pending approval. Approvals can't be given by voice.",
    parameters: {
      type: 'object',
      properties: {
        thread: {
          type: 'string',
          description: 'Thread id from get_status, or words from its title.',
        },
        decision: {
          ...nullable('string', 'decline to deny an approval. Null for questions.'),
          enum: ['decline', null],
        },
        answers: {
          type: ['array', 'null'],
          items: { type: 'array', items: { type: 'string' } },
          description:
            'For questions: one entry per question, in order. Each entry lists his choices, using option labels where they fit; several only for multiSelect questions. Null for approvals.',
        },
      },
      required: ['thread', 'decision', 'answers'],
      additionalProperties: false,
    },
    strict: true,
  },
];

/** A command waiting for Donald's yes. Confirming runs exactly this command. */
export interface PendingAction {
  command: Command;
  /** Spoken to ask for the yes. It says what `command` does. */
  question: string;
  /** Spoken once the command went through. */
  done: string;
}

export interface ToolContext {
  t3: T3Session;
  /** Whether the model has seen T3 Code text in this conversation, earlier turns included. */
  sawThreads: boolean;
  /** What this request asks Donald to confirm on his next press. */
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
                  multiSelect: question.multiSelect === true,
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

/**
 * Runs a write now, or holds it for Donald's yes when the model has read
 * thread content. One action waits at a time, so the yes always answers the
 * question he heard.
 */
async function act(
  context: ToolContext,
  action: PendingAction & { result: Result },
): Promise<Result> {
  const { result, ...pending } = action;
  if (!context.sawThreads) {
    await context.t3.dispatch(pending.command);
    return result;
  }
  if (context.proposed)
    return { error: 'Another action is already waiting for Donald to confirm. Stop here.' };
  context.proposed = pending;
  return { needsConfirmation: true };
}

async function reply(context: ToolContext, args: { thread: string; message: string }) {
  const message = args.message.trim();
  if (!message) return { error: 'The message is empty.' };
  const found = findThread(await context.t3.shell(), args.thread);
  if ('error' in found) return found;
  const { thread } = found;
  return act(context, {
    command: messageCommand(thread.id, message),
    question: `Send "${message}" to ${thread.title}? Say yes to confirm.`,
    done: `Sent to ${thread.title}.`,
    result: { sent: true, thread: thread.title },
  });
}

const loose = (text: string) => words(text).join(' ');

async function answer(
  context: ToolContext,
  args: { thread: string; decision: string | null; answers: string[][] | null },
): Promise<Result> {
  const shell = await context.t3.shell();
  const found = findThread(shell, args.thread, (thread) => needsYou(agentStatus(thread)));
  if ('error' in found) return { error: `${found.error} Only threads waiting for Donald count.` };
  const { thread } = found;
  const request = pendingRequest(await context.t3.thread(thread.id));
  if (!request) return { error: `"${thread.title}" has nothing waiting for an answer.` };

  if (request.kind === 'approval') {
    if (args.decision !== 'decline')
      return {
        error:
          "Luma can't approve by voice. Tell Donald to review and approve it in T3 Code, on the TV or his computer.",
      };
    if (!request.options.some((option) => option.decision === 'decline'))
      return { error: "This request can't be denied. Tell Donald to review it in T3 Code." };
    const what = `the ${request.requestKind} request in ${thread.title}`;
    return act(context, {
      command: decideCommand(thread.id, request.requestId, 'decline'),
      question: `Deny ${what}? Say yes to confirm.`,
      done: `Denied ${what}.`,
      result: { done: true, thread: thread.title, decision: 'decline' },
    });
  }

  const given = args.answers ?? [];
  if (given.length !== request.questions.length)
    return {
      error: `Give one entry per question, ${request.questions.length} in all.`,
      questions: request.questions.map((question) => ({
        question: question.question,
        options: question.options.map((option) => option.label),
        multiSelect: question.multiSelect === true,
      })),
    };
  const answers: Record<string, string | string[]> = {};
  const chosen: string[] = [];
  for (const [index, question] of request.questions.entries()) {
    const picks = given[index].map((pick) => pick.trim()).filter(Boolean);
    if (!picks.length || (picks.length > 1 && !question.multiSelect))
      return { error: `"${question.question}" takes exactly one answer.` };
    const values: string[] = [];
    for (const pick of picks) {
      const said = loose(pick);
      const option = question.options.find(
        (candidate) => loose(candidate.label) === said || loose(answerValue(candidate)) === said,
      );
      if (!option && question.allowCustomAnswer === false)
        return {
          error: `"${pick}" isn't an option for "${question.question}".`,
          options: question.options.map((candidate) => candidate.label),
        };
      values.push(option ? answerValue(option) : pick);
      chosen.push(option?.label ?? pick);
    }
    answers[question.id] = question.multiSelect ? values : values[0];
  }
  return act(context, {
    command: answerCommand(thread.id, request.requestId, answers),
    question: `Answer ${thread.title} with ${chosen.join(', ')}? Say yes to confirm.`,
    done: `Answered ${thread.title}.`,
    result: { done: true, thread: thread.title },
  });
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
        answers: Array.isArray(args.answers)
          ? args.answers.map((entry) =>
              Array.isArray(entry) ? entry.map(String) : [String(entry)],
            )
          : null,
      });
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
  } finally {
    // Every tool result can carry thread titles or messages.
    context.sawThreads = true;
  }
}
