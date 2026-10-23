import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { WebSocketServer } from 'ws';
import type { Pairing } from '../src/agents/pairing.ts';
import type { ThreadShell } from '../src/agents/types.ts';
import { createAssistant, spoken } from '../packages/voice/src/assistant.ts';
import { createVoiceServer } from '../packages/voice/src/server.ts';

// The voice service end to end: the Shortcut's HTTP request, a scripted
// OpenAI, and a fake T3 Code speaking the same Effect RPC as the real one.

const servers: Server[] = [];
after(() => servers.forEach((server) => server.close()));

async function listen(server: Server) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const recent = new Date().toISOString();

function thread(id: string, title: string, patch: Partial<ThreadShell> = {}): ThreadShell {
  return {
    id,
    projectId: 'p',
    title,
    status: 'idle',
    activeRunId: null,
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    branch: null,
    settledOverride: null,
    settledAt: null,
    createdAt: recent,
    updatedAt: recent,
    archivedAt: null,
    deletedAt: null,
    ...patch,
  };
}

/** A T3 Code server with three agents: one asking to deploy, one working, one done. */
async function fakeT3() {
  const commands: Record<string, unknown>[] = [];
  const http = createServer((request, response) => {
    if (request.url === '/api/auth/websocket-ticket') {
      const valid = request.headers.authorization === 'Bearer t3-token';
      response.writeHead(valid ? 200 : 401, { 'content-type': 'application/json' });
      response.end(JSON.stringify(valid ? { ticket: 'ticket' } : {}));
      return;
    }
    response.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server: http });
  wss.on('connection', (socket) => {
    const chunk = (requestId: string, value: unknown) =>
      socket.send(JSON.stringify({ _tag: 'Chunk', requestId, values: [value] }));
    socket.on('message', (data) => {
      const message = JSON.parse(String(data));
      if (message._tag !== 'Request') return;
      const { id, tag, payload } = message;
      if (tag === 'orchestration.subscribeShell')
        chunk(id, {
          kind: 'snapshot',
          snapshot: {
            snapshotSequence: 1,
            projects: [{ id: 'p', title: 'luma' }],
            threads: [
              thread('t-deploy', 'Deploy the beta', {
                status: 'waiting',
                pendingRuntimeRequest: { id: 'r1', kind: 'command', createdAt: recent },
              }),
              thread('t-login', 'Fix login bug', { status: 'running' }),
              thread('t-docs', 'Write docs', {
                status: 'completed',
                latestVisibleMessage: {
                  role: 'assistant',
                  text: 'Docs are **done**.',
                  updatedAt: recent,
                },
              }),
            ],
          },
        });
      else if (tag === 'orchestration.subscribeThread')
        chunk(id, {
          kind: 'snapshot',
          snapshotSequence: 1,
          projection:
            payload.threadId === 't-deploy'
              ? {
                  turnItems: [
                    {
                      id: 'i1',
                      ordinal: 1,
                      status: 'waiting',
                      title: null,
                      runId: null,
                      type: 'approval_request',
                      requestId: 'r1',
                      requestKind: 'command',
                      prompt: 'pnpm deploy',
                    },
                  ],
                  runtimeRequests: [
                    { id: 'r1', kind: 'command', status: 'pending', createdAt: recent },
                  ],
                }
              : { turnItems: [], runtimeRequests: [] },
        });
      else if (tag === 'orchestration.dispatchCommand') {
        commands.push(payload);
        socket.send(
          JSON.stringify({ _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value: {} } }),
        );
      }
    });
  });
  servers.push(http);
  const url = await listen(http);
  const pairing = (token = 't3-token'): Pairing => {
    const route = { url: `${url}/`, kind: 'loopback' as const };
    return {
      environmentId: 'env',
      label: 'PC',
      token,
      expiresAt: 0,
      pairedOn: route,
      routes: [route],
    };
  };
  return { pairing, commands, close: () => wss.close() };
}

type Output = Record<string, unknown>[];

/** An OpenAI Responses endpoint that plays back one output per request. */
async function fakeOpenAI(script: ((body: { input: Output }) => Output)[]) {
  const requests: { input: Output; [key: string]: unknown }[] = [];
  const baseUrl = await listen(
    createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const next = script.shift();
      if (!next || request.headers.authorization !== 'Bearer sk-test') {
        response.writeHead(500).end('{"error":"scripted failure"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ output: next(parsed) }));
    }),
  );
  return { baseUrl, requests };
}

const call =
  (name: string, args: object = {}) =>
  () => [{ type: 'function_call', call_id: `call-${name}`, name, arguments: JSON.stringify(args) }];
const say = (text: string) => () => [
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
];
/** What the tool answered, from the follow-up request the service sent OpenAI. */
const toolOutput = (input: Output, name: string) =>
  JSON.parse(String(input.find((item) => item.call_id === `call-${name}` && item.output)?.output));

async function voice(options: { baseUrl: string; pairing: () => Pairing | null }) {
  const url = await listen(
    createVoiceServer({
      token: 'shortcut-token',
      handle: createAssistant({
        openai: { apiKey: 'sk-test', baseUrl: options.baseUrl, model: 'test-model', reasoning: '' },
        pairing: options.pairing,
      }),
    }),
  );
  return async (text: string, token = 'shortcut-token') => {
    const response = await fetch(`${url}/voice`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return { status: response.status, text: await response.text() };
  };
}

test("the voice endpoint only answers the Shortcut's token", async () => {
  const openai = await fakeOpenAI([say('Nothing needs you.')]);
  const ask = await voice({ baseUrl: openai.baseUrl, pairing: () => null });

  assert.equal((await ask('status', 'wrong')).status, 401);
  assert.equal((await ask('status', '')).status, 401);
  assert.equal((await ask('   ')).status, 400);
  assert.equal(openai.requests.length, 0);

  assert.deepEqual(await ask('status'), { status: 200, text: 'Nothing needs you.' });
  const [request] = openai.requests;
  assert.equal(request.model, 'test-model');
  assert.equal(request.store, false);
  assert.deepEqual(request.input, [{ role: 'user', content: 'status' }]);
});

test("status and replies reach T3 Code through the model's tool calls", async () => {
  const t3 = await fakeT3();
  const openai = await fakeOpenAI([
    call('get_status'),
    call('reply_to_thread', { thread: 'login', message: 'Use the new token flow.' }),
    say('Sent to Fix login bug.'),
  ]);
  const ask = await voice({ baseUrl: openai.baseUrl, pairing: () => t3.pairing() });

  assert.deepEqual(await ask('what needs me, and tell the login agent to use the new token flow'), {
    status: 200,
    text: 'Sent to Fix login bug.',
  });
  assert.deepEqual(toolOutput(openai.requests[1].input, 'get_status'), {
    needsYou: [
      {
        id: 't-deploy',
        title: 'Deploy the beta',
        project: 'luma',
        waitingFor: 'approval',
        request: { kind: 'command', detail: 'pnpm deploy' },
      },
    ],
    working: [{ id: 't-login', title: 'Fix login bug', project: 'luma' }],
    done: [{ id: 't-docs', title: 'Write docs', project: 'luma', lastMessage: 'Docs are done.' }],
    failed: [],
  });
  assert.deepEqual(toolOutput(openai.requests[2].input, 'reply_to_thread'), {
    sent: true,
    thread: 'Fix login bug',
  });
  assert.equal(t3.commands.length, 1);
  assert.equal(t3.commands[0].type, 'message.dispatch');
  assert.equal(t3.commands[0].threadId, 't-login');
  assert.equal(t3.commands[0].text, 'Use the new token flow.');
  t3.close();
});

test("an approval waits for Donald's yes on the next turn", async () => {
  const t3 = await fakeT3();
  const openai = await fakeOpenAI([
    call('answer_request', { thread: 'deploy', decision: 'accept', answers: null }),
    // A model that tries to confirm on its own gets refused.
    call('confirm_action'),
    say('Approve pnpm deploy for Deploy the beta?'),
    call('confirm_action'),
    say('Approved.'),
  ]);
  const ask = await voice({ baseUrl: openai.baseUrl, pairing: () => t3.pairing() });

  assert.equal((await ask('approve the deploy')).text, 'Approve pnpm deploy for Deploy the beta?');
  assert.deepEqual(toolOutput(openai.requests[1].input, 'answer_request'), {
    needsConfirmation: true,
    thread: 'Deploy the beta',
    decision: 'accept',
    request: { kind: 'command', detail: 'pnpm deploy' },
  });
  assert.match(toolOutput(openai.requests[2].input, 'confirm_action').error, /Nothing is waiting/);
  assert.equal(t3.commands.length, 0);

  assert.equal((await ask('yes')).text, 'Approved.');
  // The model sees the question it asked, so "yes" has something to refer to.
  assert.deepEqual(openai.requests[3].input.slice(0, 3), [
    { role: 'user', content: 'approve the deploy' },
    { role: 'assistant', content: 'Approve pnpm deploy for Deploy the beta?' },
    { role: 'user', content: 'yes' },
  ]);
  assert.deepEqual(
    t3.commands.map(({ type, threadId, requestId, decision }) => ({
      type,
      threadId,
      requestId,
      decision,
    })),
    [
      {
        type: 'runtime-request.respond',
        threadId: 't-deploy',
        requestId: 'r1',
        decision: 'accept',
      },
    ],
  );
  t3.close();
});

test('failures come back as something the Shortcut can speak', async () => {
  const t3 = await fakeT3();
  const openai = await fakeOpenAI([
    call('reply_to_thread', { thread: 'payments', message: 'hi' }),
    say('Which thread did you mean?'),
    call('get_status'),
    call('get_status'),
  ]);
  let pairing: Pairing | null = t3.pairing();
  const ask = await voice({ baseUrl: openai.baseUrl, pairing: () => pairing });

  // An unknown thread goes back to the model, which can ask.
  assert.equal((await ask('tell payments hi')).text, 'Which thread did you mean?');
  assert.match(toolOutput(openai.requests[1].input, 'reply_to_thread').error, /No thread matches/);

  pairing = t3.pairing('revoked');
  assert.equal((await ask('status')).text, spoken.expired);
  pairing = { ...t3.pairing(), pairedOn: { url: 'http://127.0.0.1:9/', kind: 'loopback' } };
  assert.equal((await ask('status')).text, spoken.unreachable);
  // The script has run out, so OpenAI answers with an error.
  assert.equal((await ask('status')).text, spoken.openai);
  assert.equal(t3.commands.length, 0);
  t3.close();
});
