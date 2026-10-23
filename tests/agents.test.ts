import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import {
  agentStatus,
  applyShellItem,
  applyThreadItem,
  emptyDetail,
  emptyShell,
  pendingRequest,
  shelfAgents,
} from '../src/agents/model.ts';
import {
  describe,
  ORCHESTRATION_PROTOCOL,
  pair,
  pairingCode,
  websocketTicket,
} from '../src/agents/pairing.ts';
import { learnRoutes, parsePairingInput, routeFor, routeKind } from '../src/agents/routes.ts';
import type { ThreadShell } from '../src/agents/types.ts';

const now = Date.parse('2026-10-20T20:00:00Z');
const minutesAgo = (minutes: number) => new Date(now - minutes * 60000).toISOString();

function thread(id: string, patch: Partial<ThreadShell> = {}): ThreadShell {
  return {
    id,
    projectId: 'p',
    title: id,
    status: 'idle',
    activeRunId: null,
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    branch: null,
    settledOverride: null,
    settledAt: null,
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(1),
    archivedAt: null,
    deletedAt: null,
    ...patch,
  };
}

test('agent status matches T3 Code: questions and approvals need you, auth refreshes do not', () => {
  const request = { id: 'r', createdAt: minutesAgo(1) };
  assert.equal(
    agentStatus(thread('a', { pendingRuntimeRequest: { ...request, kind: 'command' } })),
    'approval',
  );
  assert.equal(
    agentStatus(thread('a', { pendingRuntimeRequest: { ...request, kind: 'user_input' } })),
    'input',
  );
  // A non-blocking question while the run keeps going is just work.
  assert.equal(
    agentStatus(
      thread('a', {
        status: 'running',
        pendingRuntimeRequest: { ...request, kind: 'user_input', blocking: false },
      }),
    ),
    'running',
  );
  assert.equal(
    agentStatus(
      thread('a', {
        status: 'running',
        pendingRuntimeRequest: { ...request, kind: 'auth_refresh' },
      }),
    ),
    'running',
  );
  assert.equal(
    agentStatus(thread('a', { status: 'completed', activityRunStatus: 'starting' })),
    'starting',
  );
  assert.equal(agentStatus(thread('a', { status: 'interrupted' })), 'idle');
});

test('the shelf puts the longest-waiting request first and drops settled, old and subagent threads', () => {
  let shell = applyShellItem(emptyShell(), {
    kind: 'snapshot',
    snapshot: {
      snapshotSequence: 10,
      projects: [{ id: 'p', title: 'luma' }],
      threads: [
        thread('recent-done', { status: 'completed', updatedAt: minutesAgo(5) }),
        thread('working', { status: 'running', updatedAt: minutesAgo(2) }),
        thread('newer-request', {
          pendingRuntimeRequest: { id: 'r2', kind: 'command', createdAt: minutesAgo(1) },
        }),
        thread('older-request', {
          pendingRuntimeRequest: { id: 'r1', kind: 'file-change', createdAt: minutesAgo(9) },
        }),
        thread('settled', { status: 'completed', settledAt: minutesAgo(3) }),
        thread('yesterday', { status: 'completed', updatedAt: minutesAgo(60 * 25) }),
        thread('helper', { status: 'running', lineage: { relationshipToParent: 'subagent' } }),
      ],
    },
  });
  assert.deepEqual(
    shelfAgents(shell, now).map((agent) => agent.thread.id),
    ['older-request', 'newer-request', 'working', 'recent-done'],
  );

  // Events at or before the snapshot are already reflected and must not apply.
  shell = applyShellItem(shell, {
    kind: 'thread.removed',
    sequence: 10,
    threadId: 'working',
  });
  assert.ok(shell.threads.has('working'));
  shell = applyShellItem(shell, {
    kind: 'thread.updated',
    sequence: 11,
    location: 'archive',
    thread: thread('working'),
  });
  assert.ok(!shell.threads.has('working'));

  // A later projects-only snapshot refreshes metadata without wiping threads.
  shell = applyShellItem(shell, {
    kind: 'snapshot',
    snapshot: { snapshotSequence: 12, projects: [{ id: 'p', title: 'Luma' }], threads: [] },
  });
  assert.equal(shell.threads.size, 6);
  assert.equal(shell.projects.get('p')?.title, 'Luma');
});

test('a pending approval pairs with its turn item and keeps the server’s decisions', () => {
  const base = { ordinal: 1, status: 'waiting', title: null, runId: null };
  let detail = applyThreadItem(emptyDetail('t'), {
    kind: 'snapshot',
    snapshotSequence: 1,
    projection: {
      turnItems: [
        {
          ...base,
          id: 'i1',
          type: 'approval_request',
          requestId: 'r1',
          requestKind: 'command',
          prompt: 'pnpm test',
          options: [
            { decision: 'accept', label: 'Yes' },
            { decision: 'decline', label: 'No' },
            { decision: 'cancel', label: 'Cancel' },
          ],
        },
      ],
      runtimeRequests: [{ id: 'r1', kind: 'command', status: 'pending', createdAt: minutesAgo(1) }],
    },
  });
  assert.deepEqual(pendingRequest(detail), {
    kind: 'approval',
    requestId: 'r1',
    requestKind: 'command',
    detail: 'pnpm test',
    options: [
      { decision: 'accept', label: 'Yes' },
      { decision: 'decline', label: 'No' },
    ],
  });

  detail = applyThreadItem(detail, {
    kind: 'event',
    sequence: 2,
    event: {
      type: 'runtime-request.updated',
      payload: { id: 'r1', kind: 'command', status: 'resolved', createdAt: minutesAgo(1) },
    },
  });
  assert.equal(pendingRequest(detail), null);
});

test('pairing accepts a full link or an address with a code', () => {
  assert.deepEqual(parsePairingInput('http://192.168.1.10:3773/pair#token=K7QM4XR2HP9D', ''), {
    url: 'http://192.168.1.10:3773/',
    code: 'K7QM4XR2HP9D',
  });
  assert.deepEqual(parsePairingInput(' 192.168.1.10:3773 ', 'k7qm-4xr2-hp9d'), {
    url: 'http://192.168.1.10:3773/',
    code: 'K7QM4XR2HP9D',
  });
  assert.equal(
    parsePairingInput('pc.tail1234.ts.net', 'K7QM4XR2HP9D').url,
    'https://pc.tail1234.ts.net/',
  );
  assert.throws(() => parsePairingInput('192.168.1.10:3773', ''), /missingCode/);
});

test('Tailscale is only trusted where the server says so', () => {
  assert.equal(routeKind(new URL('http://100.110.174.118:3773/')), 'vpn');
  assert.equal(routeKind(new URL('http://100.110.174.118:3773/'), 'tailnet'), 'tailnet');
  assert.equal(routeKind(new URL('https://pc.tail1234.ts.net/')), 'tailnet');
  assert.equal(routeKind(new URL('http://192.168.1.10:3773/')), 'lan');
});

test('learned routes rank LAN first and never expose an HTTPS-paired token in clear', () => {
  const endpoints = [
    { kind: 'tailnet' as const, httpBaseUrl: 'http://100.110.174.118:3773/' },
    { kind: 'lan' as const, httpBaseUrl: 'http://192.168.1.10:3773/' },
    { kind: 'lan' as const, httpBaseUrl: 'http://127.0.0.1:3773/' },
    { kind: 'tailnet' as const, httpBaseUrl: 'https://pc.tail1234.ts.net/' },
  ];

  const lan = routeFor('http://192.168.1.10:3773/');
  assert.deepEqual(
    learnRoutes([lan], endpoints, lan, false).map((route) => route.url),
    ['http://192.168.1.10:3773/', 'http://100.110.174.118:3773/', 'https://pc.tail1234.ts.net/'],
  );

  const serve = routeFor('https://pc.tail1234.ts.net/');
  assert.deepEqual(
    learnRoutes([serve], endpoints, serve, false).map((route) => route.url),
    ['https://pc.tail1234.ts.net/', 'http://100.110.174.118:3773/'],
  );

  // From an HTTPS page the browser would block every plain-HTTP address.
  assert.deepEqual(
    learnRoutes([lan], endpoints, lan, true).map((route) => route.url),
    ['http://192.168.1.10:3773/', 'https://pc.tail1234.ts.net/'],
  );
});

test('a projects-only refresh keeps the projects it leaves out', () => {
  let shell = applyShellItem(emptyShell(), {
    kind: 'snapshot',
    snapshot: {
      snapshotSequence: 1,
      projects: [
        { id: 'a', title: 'luma' },
        { id: 'b', title: 't3code' },
      ],
      threads: [thread('t', { projectId: 'b' })],
    },
  });
  shell = applyShellItem(shell, {
    kind: 'snapshot',
    snapshot: { snapshotSequence: 2, projects: [{ id: 'a', title: 'Luma' }], threads: [] },
  });
  assert.equal(shell.projects.get('a')?.title, 'Luma');
  assert.equal(shell.projects.get('b')?.title, 't3code');
});

test('working agents keep their shelf order while they emit updates', () => {
  const shell = applyShellItem(emptyShell(), {
    kind: 'snapshot',
    snapshot: {
      snapshotSequence: 1,
      projects: [],
      threads: [
        thread('older-run', {
          status: 'running',
          latestRunStartedAt: minutesAgo(30),
          updatedAt: minutesAgo(0),
        }),
        thread('newer-run', {
          status: 'running',
          latestRunStartedAt: minutesAgo(5),
          updatedAt: minutesAgo(4),
        }),
      ],
    },
  });
  assert.deepEqual(
    shelfAgents(shell, now).map((agent) => agent.thread.id),
    ['newer-run', 'older-run'],
  );
});

/** Serves `handler` on a free loopback port and closes it when the test ends. */
async function serve(
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

const json = (response: ServerResponse, body: unknown) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
};

test('an identity check only vouches for the address it asked, not where it was redirected', async (t) => {
  const paired = await serve(t, (_, response) =>
    json(response, { environmentId: 'env-1', label: 'workstation' }),
  );
  const other = await serve(t, (_, response) => {
    response.writeHead(302, { location: `${paired}.well-known/t3/environment` });
    response.end();
  });
  assert.equal((await describe(routeFor(paired), 2000)).environmentId, 'env-1');
  await assert.rejects(describe(routeFor(other), 2000));
});

test('the pairing code and token never follow a redirect to another address', async (t) => {
  // Anything reaching this address got a credential it never proved it should have.
  const forwarded: string[] = [];
  const elsewhere = await serve(t, (request, response) => {
    forwarded.push(`${request.method} ${request.url}`);
    json(response, { access_token: 'stolen', ticket: 'stolen', credential: 'stolen' });
  });
  const paired = await serve(t, (request, response) => {
    if (request.url === '/.well-known/t3/environment')
      return json(response, {
        environmentId: 'env-1',
        label: 'workstation',
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL,
      });
    // 307 keeps the method and body, so the code or token would go along.
    response.writeHead(307, { location: `${elsewhere}${request.url?.slice(1)}` });
    response.end();
  });
  const route = routeFor(paired);
  await assert.rejects(pair(paired, 'BOOTSTRAP', 'Luma TV'));
  await assert.rejects(websocketTicket(route, 'token-1'));
  await assert.rejects(pairingCode(route, 'token-1', 'Luma TV (T3 Code)'));
  assert.deepEqual(forwarded, []);
});
