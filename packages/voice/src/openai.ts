// A small client for OpenAI's Responses API with function tools. Requests use
// `store: false`, so OpenAI keeps no copy of the conversation; reasoning comes
// back encrypted and goes back in with the tool results.

export interface OpenAISettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoning: string;
}

export type InputItem = Record<string, unknown>;

type OutputItem = InputItem & {
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
};

export class OpenAIFailure extends Error {
  constructor(readonly code: 'key' | 'unavailable') {
    super(code);
  }
}

const TIMEOUT_MS = 15000;

async function create(
  settings: OpenAISettings,
  body: Record<string, unknown>,
): Promise<OutputItem[]> {
  let response: Response;
  try {
    response = await fetch(`${settings.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: settings.model,
        store: false,
        ...(settings.reasoning
          ? {
              reasoning: { effort: settings.reasoning },
              include: ['reasoning.encrypted_content'],
            }
          : {}),
        ...body,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new OpenAIFailure('unavailable');
  }
  if (response.status === 401 || response.status === 403) throw new OpenAIFailure('key');
  if (!response.ok) {
    // The body explains the failure without echoing the key.
    console.error(`OpenAI ${response.status}: ${(await response.text()).slice(0, 500)}`);
    throw new OpenAIFailure('unavailable');
  }
  const json = await response.json().catch(() => null);
  if (!Array.isArray(json?.output)) throw new OpenAIFailure('unavailable');
  return json.output;
}

const MAX_ROUNDS = 5;

/** Runs the model until it answers in words, calling tools as it asks. */
export async function converse(
  settings: OpenAISettings,
  options: {
    instructions: string;
    input: InputItem[];
    tools: object[];
    runTool: (name: string, args: string) => Promise<unknown>;
  },
): Promise<string> {
  const input = [...options.input];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const output = await create(settings, {
      instructions: options.instructions,
      input,
      tools: options.tools,
    });
    input.push(...output);
    const calls = output.filter((item) => item.type === 'function_call');
    if (!calls.length)
      return output
        .flatMap((item) => (item.type === 'message' ? (item.content ?? []) : []))
        .map((part) => (part.type === 'output_text' ? (part.text ?? '') : ''))
        .join('')
        .trim();
    for (const call of calls)
      input.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(await options.runTool(call.name ?? '', call.arguments ?? '')),
      });
  }
  return '';
}
