import { test, expect, type Page, type Route } from '@playwright/test';

// A stand-in T3 Code server: the HTTP pairing endpoints plus the Effect RPC
// WebSocket, answering just enough to show one agent waiting for approval.
const server = 'http://192.168.50.5:3773';
const threadId = 'thread-1';
const now = new Date().toISOString();
const shellSnapshot = {
  kind: 'snapshot',
  snapshot: {
    snapshotSequence: 5,
    projects: [{ id: 'p1', title: 'luma' }],
    threads: [
      {
        id: threadId,
        projectId: 'p1',
        title: 'Browser tests for the Agents tile',
        modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' },
        status: 'running',
        activityRunStatus: 'waiting',
        activeRunId: 'run-1',
        pendingRuntimeRequest: { id: 'r1', kind: 'command', createdAt: now, blocking: true },
        latestVisibleMessage: {
          role: 'assistant',
          text: 'Everything type-checks. I’d like to run the test.',
          updatedAt: now,
        },
        branch: 'agents',
        settledOverride: null,
        settledAt: null,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
      },
    ],
  },
};
const threadSnapshot = {
  kind: 'snapshot',
  snapshotSequence: 9,
  projection: {
    turnItems: [
      {
        id: 'i1',
        ordinal: 1,
        status: 'waiting',
        title: null,
        runId: 'run-1',
        type: 'approval_request',
        requestId: 'r1',
        requestKind: 'command',
        prompt: 'pnpm test:browser tests/agents.spec.ts',
      },
    ],
    runtimeRequests: [{ id: 'r1', kind: 'command', status: 'pending', createdAt: now }],
  },
};

async function mockT3(page: Page, config = {}) {
  const commands: Record<string, unknown>[] = [];
  const json = (route: Route, body: unknown) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type',
      },
      body: JSON.stringify(body),
    });
  await page.route(`${server}/**`, (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'OPTIONS') return json(route, {});
    if (url.pathname === '/.well-known/t3/environment')
      return json(route, {
        environmentId: 'env-1',
        label: 'workstation',
        orchestrationProtocolVersion: 2,
      });
    if (url.pathname === '/oauth/token')
      return json(route, { access_token: 'token-1', token_type: 'Bearer', expires_in: 2592000 });
    if (url.pathname === '/api/auth/websocket-ticket')
      return json(route, { ticket: 'ticket-1', expiresAt: now });
    return route.fulfill({ status: 404 });
  });
  await page.routeWebSocket(/192\.168\.50\.5:3773\/ws/, (socket) => {
    const reply = (message: object) => socket.send(JSON.stringify(message));
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message._tag !== 'Request') return;
      const { id, tag, payload } = message;
      if (tag === 'orchestration.subscribeShell')
        reply({ _tag: 'Chunk', requestId: id, values: [shellSnapshot] });
      else if (tag === 'orchestration.subscribeThread')
        reply({ _tag: 'Chunk', requestId: id, values: [threadSnapshot] });
      else if (tag === 'server.getConfig')
        reply({ _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value: config } });
      else if (tag === 'orchestration.dispatchCommand') {
        commands.push(payload);
        reply({ _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value: { sequence: 6 } } });
      }
    });
  });
  return commands;
}

test('the T3 Code app opens to pairing, then OK approves the waiting agent', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const commands = await mockT3(page);
  await page.goto('/');

  // Unpaired, the app lives in the library and opens straight to the pairing box.
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Open T3 Code', exact: true }).click();
  const address = page.getByLabel('T3 Code address');
  await expect(address).toBeFocused();
  await address.fill(`${server}/pair#token=ABCD-EFGH-JKLM`);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  // The "Connecting…" loader is a status too, while the first snapshot loads.
  await expect(page.getByRole('status').filter({ hasText: 'Paired with T3 Code' })).toBeVisible();

  await expect(
    page.getByRole('heading', { name: 'Browser tests for the Agents tile' }),
  ).toBeVisible();
  await expect(page.getByText('pnpm test:browser tests/agents.spec.ts')).toBeVisible();
  await expect(page.locator('[data-focusable="agent-decision-accept"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    type: 'runtime-request.respond',
    threadId,
    requestId: 'r1',
    decision: 'accept',
  });

  // Pairing pins the app first on Home.
  await page.keyboard.press('Escape');
  const tile = page.locator('.favorites-grid .app-tile').first();
  await expect(tile).toHaveAccessibleName('Open T3 Code');
  await expect(tile.getByLabel('1 waiting for you')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Settings has no pairing; the connection lives in the app', async ({ page }) => {
  await mockT3(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('T3 Code address')).toHaveCount(0);
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Open T3 Code', exact: true }).click();
  await page.getByLabel('T3 Code address').fill(server);
  await page.getByLabel('Pairing code').fill('ABCDEFGHJKLM');
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await page.locator('[data-focusable="agents-connection"]').click();
  await expect(page.getByRole('dialog')).toContainText('workstation');
  await page.getByRole('button', { name: /Unpair/ }).click();
  await expect(page.getByLabel('T3 Code address')).toBeVisible();
});

// The same token, saved as if Luma had paired earlier. A reload keeps what Luma saved since.
const seedPairing = (page: Page, pairedOn: { url: string; kind: string }, routes = [pairedOn]) =>
  page.addInitScript(
    (pairing) => {
      if (!localStorage.getItem('luma.agents.v1'))
        localStorage.setItem('luma.agents.v1', JSON.stringify(pairing));
    },
    {
      environmentId: 'env-1',
      label: 'workstation',
      token: 'token-1',
      expiresAt: Date.now() + 86400000,
      pairedOn,
      routes,
    },
  );

// The Fire TV shell, which can host T3 Code's web app in a second WebView.
async function fakeWebAppShell(page: Page) {
  const opened: string[][] = [];
  await page.exposeFunction('recordOpenWebApp', (url: string, then: string) =>
    opened.push([url, then]),
  );
  await page.addInitScript(() => {
    const w = window as typeof window & {
      recordOpenWebApp: (url: string, then: string) => void;
      LumaAndroid: object;
    };
    w.LumaAndroid = {
      isTV: () => false,
      openWebApp: (url: string, then: string) => w.recordOpenWebApp(url, then),
    };
  });
  return opened;
}

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
};
const other = 'http://100.100.1.2:3773';
const otherRoute = { url: `${other}/`, kind: 'tailnet' };

test('the token never goes to an address that answers as another server', async ({ page }) => {
  const lan = { url: `${server}/`, kind: 'lan' };
  await seedPairing(page, lan, [lan, otherRoute]);
  // The paired server answers but can't mint a ticket right now.
  await page.route(`${server}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    if (route.request().method() === 'OPTIONS') return route.fulfill({ headers: cors });
    if (pathname === '/.well-known/t3/environment')
      return route.fulfill({
        headers: cors,
        json: { environmentId: 'env-1', label: 'workstation' },
      });
    return route.fulfill({ status: 503, headers: cors });
  });
  // A different T3 Code server that would reject the token.
  const leaked: string[] = [];
  await page.route(`${other}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (route.request().method() === 'OPTIONS') return route.fulfill({ headers: cors });
    const authorization = await route.request().headerValue('authorization');
    if (authorization) leaked.push(authorization);
    if (pathname === '/.well-known/t3/environment')
      return route.fulfill({ headers: cors, json: { environmentId: 'env-2', label: 'laptop' } });
    return route.fulfill({ status: 401, headers: cors });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Open T3 Code', exact: true }).click();
  await expect(page.getByText(/T3 Code is out of reach\.|Pair Luma again\./)).toBeVisible();
  expect(leaked).toEqual([]);
  await expect(page.getByText('T3 Code is out of reach.')).toBeVisible();
});

test('an address that answered as another server gets no token after a reload', async ({
  page,
}) => {
  const lan = { url: `${server}/`, kind: 'lan' };
  await seedPairing(page, lan, [lan, otherRoute]);
  // The paired server answers but can't mint a ticket right now.
  const tickets: (string | null)[] = [];
  await page.route(`${server}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (route.request().method() === 'OPTIONS') return route.fulfill({ headers: cors });
    if (pathname === '/.well-known/t3/environment')
      return route.fulfill({
        headers: cors,
        json: { environmentId: 'env-1', label: 'workstation' },
      });
    if (pathname === '/api/auth/websocket-ticket')
      tickets.push(await route.request().headerValue('authorization'));
    return route.fulfill({ status: 503, headers: cors });
  });
  // Another T3 Code server answers before the reload; after it, its check fails.
  let reloaded = false;
  const leaked: string[] = [];
  await page.route(`${other}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (route.request().method() === 'OPTIONS') return route.fulfill({ headers: cors });
    const authorization = await route.request().headerValue('authorization');
    if (authorization) leaked.push(authorization);
    if (pathname !== '/.well-known/t3/environment')
      return route.fulfill({ status: 401, headers: cors });
    if (reloaded) return route.fulfill({ status: 503, headers: cors });
    return route.fulfill({ headers: cors, json: { environmentId: 'env-2', label: 'laptop' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Open T3 Code', exact: true }).click();
  await expect(page.getByText('T3 Code is out of reach.')).toBeVisible();

  reloaded = true;
  tickets.length = 0;
  await page.reload();
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Open T3 Code', exact: true }).click();
  await expect(page.getByText(/T3 Code is out of reach\.|Pair Luma again\./)).toBeVisible();
  expect(leaked).toEqual([]);
  // The paired server still got the token, so the reconnect did run.
  expect(tickets).toContain('Bearer token-1');
  await expect(page.getByText('T3 Code is out of reach.')).toBeVisible();
});

test('an address learned from the server gets no token when its check fails', async ({ page }) => {
  const lan = { url: `${server}/`, kind: 'lan' };
  await seedPairing(page, lan);
  await mockT3(page, { directEndpoints: [{ kind: 'tailnet', httpBaseUrl: other }] });
  // Registered after mockT3, so it handles this path first. The paired server
  // stops minting tickets after the first connection.
  let broken = false;
  const tickets: (string | null)[] = [];
  await page.route(`${server}/api/auth/websocket-ticket`, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ headers: cors });
    tickets.push(await route.request().headerValue('authorization'));
    if (broken) return route.fulfill({ status: 503, headers: cors });
    return route.fulfill({ headers: cors, json: { ticket: 'ticket-1', expiresAt: now } });
  });
  // The learned address doesn't answer its check.
  let probes = 0;
  const leaked: string[] = [];
  await page.route(`${other}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (route.request().method() === 'OPTIONS') return route.fulfill({ headers: cors });
    const authorization = await route.request().headerValue('authorization');
    if (authorization) leaked.push(authorization);
    if (pathname === '/.well-known/t3/environment') probes++;
    return route.fulfill({ status: pathname === '/.well-known/t3/environment' ? 503 : 401 });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Open T3 Code', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Browser tests for the Agents tile' }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('luma.agents.v1')))
    .toContain(otherRoute.url);

  broken = true;
  tickets.length = 0;
  await page.reload();
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Open T3 Code', exact: true }).click();
  await expect(page.getByText(/T3 Code is out of reach\.|Pair Luma again\./)).toBeVisible();
  expect(leaked).toEqual([]);
  // Luma checked the learned address and still offered the token to the paired one.
  expect(probes).toBeGreaterThan(0);
  expect(tickets).toContain('Bearer token-1');
  await expect(page.getByText('T3 Code is out of reach.')).toBeVisible();
});

test('Open T3 Code pairs the web app on the paired server', async ({ page }) => {
  const minted: (string | null)[] = [];
  await mockT3(page);
  // Registered after mockT3, so it handles this path first.
  await page.route(`${server}/api/auth/pairing-token`, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ headers: cors });
    minted.push(await route.request().headerValue('authorization'));
    return route.fulfill({ headers: cors, json: { credential: 'WEB-CODE' } });
  });
  await seedPairing(page, { url: `${server}/`, kind: 'lan' });
  const opened = await fakeWebAppShell(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Open T3 Code', exact: true }).click();
  await page.locator('[data-focusable="agents-open-t3"]').click();
  await expect.poll(() => opened).toEqual([[`${server}/pair#token=WEB-CODE`, `${server}/`]]);
  expect(minted).toEqual(['Bearer token-1']);
});

for (const [name, trigger] of [
  ['Open T3 Code', (page: Page) => page.locator('[data-focusable="agents-open-t3"]').click()],
  [
    'the shell asking to re-pair',
    (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('luma:t3-repair'))),
  ],
] as const)
  test(`${name} never sends the token to another server at the paired address`, async ({
    page,
  }) => {
    // The paired address now belongs to a different T3 Code server.
    await seedPairing(page, otherRoute);
    const opened = await fakeWebAppShell(page);
    const leaked: string[] = [];
    await page.route(`${other}/**`, async (route) => {
      const { pathname } = new URL(route.request().url());
      if (route.request().method() === 'OPTIONS') return route.fulfill({ headers: cors });
      const authorization = await route.request().headerValue('authorization');
      if (authorization) leaked.push(authorization);
      if (pathname !== '/.well-known/t3/environment')
        return route.fulfill({ status: 401, headers: cors });
      return route.fulfill({ headers: cors, json: { environmentId: 'env-2', label: 'laptop' } });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Apps', exact: true }).click();
    await page.getByRole('button', { name: 'Open T3 Code', exact: true }).click();
    await expect(page.getByText('T3 Code is out of reach.')).toBeVisible();
    await trigger(page);
    await expect(page.getByRole('alert')).toContainText(/open T3 Code/);
    expect(leaked).toEqual([]);
    expect(opened).toEqual([]);
  });

test('Open T3 Code sends no token to a paired address that fails its check', async ({ page }) => {
  await seedPairing(page, { url: `${server}/`, kind: 'lan' });
  const opened = await fakeWebAppShell(page);
  // Something at the paired address would take the token, but doesn't answer the check.
  const leaked: string[] = [];
  await page.route(`${server}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (route.request().method() === 'OPTIONS') return route.fulfill({ headers: cors });
    const authorization = await route.request().headerValue('authorization');
    if (authorization) leaked.push(authorization);
    if (pathname === '/api/auth/pairing-token')
      return route.fulfill({ headers: cors, json: { credential: 'WEB-CODE' } });
    return route.fulfill({ status: 503, headers: cors });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Open T3 Code', exact: true }).click();
  await expect(page.getByText('T3 Code is out of reach.')).toBeVisible();
  await page.locator('[data-focusable="agents-open-t3"]').click();
  await expect(page.getByRole('alert')).toContainText(/open T3 Code/);
  expect(leaked).toEqual([]);
  expect(opened).toEqual([]);
});
