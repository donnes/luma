import { summary } from '../../../src/agents/model.ts';
import type { Pairing } from '../../../src/agents/pairing.ts';
import { converse, OpenAIFailure, type InputItem, type OpenAISettings } from './openai.ts';
import { T3Session, T3Unavailable } from './t3.ts';
import { runTool, toolDefinitions, type PendingAction, type ToolContext } from './tools.ts';

const INSTRUCTIONS = `You are Luma, Donald's voice assistant for his T3 Code coding agents. He talks to you from his iPhone and hears your reply spoken aloud.

- Reply in one or two short sentences, under 30 words, in the language he speaks. Plain words only: no markdown, ids, URLs or lists.
- Use the tools to learn and act; never guess what an agent is doing. Refer to threads by title.
- With several agents, lead with what needs him, then mention counts for the rest.
- When a tool result has needsConfirmation, say what will be approved in a few words and ask him to confirm. Call confirm_action only when his next message clearly says yes.
- When a tool returns an error about the thread, ask which thread he meant, naming at most three.
- You can only check status, reply to threads and answer approvals or questions. For anything else, like starting a thread, controlling the TV or running commands, say you can't do that yet.`;

/** Spoken when Luma can't get an answer, so the Shortcut never goes quiet. */
export const spoken = {
  unpaired: "I'm not paired with T3 Code. Run pnpm voice pair on the PC.",
  expired: 'My T3 Code pairing expired. Pair me again with pnpm voice pair on the PC.',
  unreachable: "I can't reach T3 Code. Is it running on the PC?",
  key: 'OpenAI rejected my API key. Check voice.env on the PC.',
  openai: "I couldn't reach OpenAI. Try again in a moment.",
  empty: "Sorry, I didn't get that.",
  failed: 'Something went wrong. Check the voice service log on the PC.',
};

/** Follow-ups like "yes" or "the second one" need the last exchange. */
const MEMORY_MS = 3 * 60000;
const MEMORY_TURNS = 3;
const MAX_REPLY = 300;

export function createAssistant(options: {
  openai: OpenAISettings;
  pairing: () => Pairing | null;
}) {
  let history: { at: number; items: InputItem[] }[] = [];
  /** An approval asked about on the previous turn, and only that turn. */
  let confirmable: PendingAction | null = null;

  return async function handle(text: string): Promise<string> {
    const now = Date.now();
    history = history.filter((turn) => now - turn.at < MEMORY_MS).slice(-MEMORY_TURNS);
    const context: ToolContext = {
      t3: new T3Session(options.pairing()),
      confirmable: history.length ? confirmable : null,
      proposed: null,
    };
    confirmable = null;
    const said: InputItem = { role: 'user', content: text };
    let reply: string;
    try {
      reply =
        (await converse(options.openai, {
          instructions: INSTRUCTIONS,
          input: [...history.flatMap((turn) => turn.items), said],
          tools: toolDefinitions,
          runTool: (name, args) => runTool(context, name, args),
        })) || spoken.empty;
    } catch (error) {
      if (error instanceof T3Unavailable) return spoken[error.code];
      if (error instanceof OpenAIFailure) return error.code === 'key' ? spoken.key : spoken.openai;
      console.error(error);
      return spoken.failed;
    } finally {
      context.t3.close();
    }
    reply = summary(reply, MAX_REPLY);
    confirmable = context.proposed;
    history.push({ at: now, items: [said, { role: 'assistant', content: reply }] });
    return reply;
  };
}
