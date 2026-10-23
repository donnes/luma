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

async function mockT3(page: Page, shell: object = shellSnapshot) {
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
        reply({ _tag: 'Chunk', requestId: id, values: [shell] });
      else if (tag === 'orchestration.subscribeThread')
        reply({ _tag: 'Chunk', requestId: id, values: [threadSnapshot] });
      else if (tag === 'server.getConfig')
        reply({ _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value: {} } });
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
  // The toast can share the screen with the "Connecting…" status.
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

async function pair(page: Page) {
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Open T3 Code', exact: true }).click();
  await page.getByLabel('T3 Code address').fill(server);
  await page.getByLabel('Pairing code').fill('ABCDEFGHJKLM');
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
}

test('Settings has no pairing; the connection lives in the app', async ({ page }) => {
  await mockT3(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('T3 Code address')).toHaveCount(0);
  await pair(page);
  await page.locator('[data-focusable="agents-connection"]').click();
  await expect(page.getByRole('dialog')).toContainText('workstation');
  await page.getByRole('button', { name: /Unpair/ }).click();
  await expect(page.getByLabel('T3 Code address')).toBeVisible();
});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
const inboxThread = (
  id: string,
  projectId: string,
  title: string,
  patch: Record<string, unknown>,
) => ({
  ...shellSnapshot.snapshot.threads[0],
  id,
  projectId,
  title,
  status: 'completed',
  activityRunStatus: null,
  activeRunId: null,
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  createdAt: minutesAgo(600),
  updatedAt: minutesAgo(5),
  ...patch,
});
const inboxSnapshot = {
  kind: 'snapshot',
  snapshot: {
    snapshotSequence: 5,
    projects: [
      { id: 'p1', title: 'luma' },
      { id: 'p2', title: 't3code' },
      { id: 'p3', title: 'configs' },
    ],
    threads: [
      inboxThread('ask', 'p1', 'Which overlay permission should the Fire TV shell request?', {
        status: 'running',
        activityRunStatus: 'waiting',
        pendingRuntimeRequest: { id: 'r2', kind: 'user_input', createdAt: minutesAgo(4) },
      }),
      inboxThread('approve', 'p1', 'Run the agents inbox browser tests', {
        status: 'running',
        activityRunStatus: 'waiting',
        pendingRuntimeRequest: { id: 'r1', kind: 'command', createdAt: minutesAgo(20) },
      }),
      inboxThread('scroll', 'p2', 'Fix settings scrolling from wider gutter areas', {
        updatedAt: minutesAgo(62),
      }),
      inboxThread('dns', 'p3', 'Cloudflare DNS lookup and preview record for the staging domain', {
        updatedAt: minutesAgo(75),
        settledAt: minutesAgo(70),
      }),
      inboxThread('keys', 'p3', 'Sync Hyprland keybindings with the Mac', {
        status: 'failed',
        updatedAt: minutesAgo(130),
      }),
      inboxThread('inbox', 'p1', 'Agents inbox panel for Luma', {
        status: 'running',
        activeRunId: 'run-2',
        latestRunStartedAt: minutesAgo(12),
        updatedAt: minutesAgo(0),
      }),
      inboxThread('old', 'p2', 'Last week’s thread stays out of the inbox', {
        updatedAt: minutesAgo(60 * 24 * 7),
      }),
    ],
  },
};

test('the inbox groups threads, the remote moves through them and OK opens one', async ({
  page,
}) => {
  await mockT3(page, inboxSnapshot);
  await page.goto('/');
  await pair(page);

  const button = page.locator('[data-focusable="agents-inbox"]');
  await expect(button).toHaveAccessibleName('Inbox 2 waiting for you');
  await button.focus();
  await page.keyboard.press('Enter');
  const inbox = page.getByRole('dialog', { name: 'Inbox' });
  await expect(inbox.getByRole('heading')).toHaveText(['Inbox', 'Needs you', 'Done', 'Working']);
  await expect(inbox.getByRole('button')).toHaveText([
    /^Run the agents inbox browser tests/,
    /^Which overlay permission/,
    /^Fix settings scrolling/,
    /^Cloudflare DNS lookup/,
    /^Sync Hyprland keybindings/,
    /^Agents inbox panel for Luma/,
  ]);

  // Back closes it and hands focus back to the button that opened it.
  await expect(inbox.getByRole('button').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(inbox).toBeHidden();
  await expect(button).toBeFocused();

  // Down crosses from Needs you into Done; OK opens that thread.
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(inbox.getByRole('button', { name: /^Fix settings scrolling/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(inbox).toBeHidden();
  await expect(
    page.getByRole('heading', { name: 'Fix settings scrolling from wider gutter areas' }),
  ).toBeVisible();
});

test('a request past the shelf opens from the inbox with its approval and counts on the badge', async ({
  page,
}) => {
  // Thirteen approvals: the shelf keeps the twelve that waited longest.
  const threads = Array.from({ length: 13 }, (_, index) =>
    inboxThread(`approve-${index + 1}`, 'p1', `Approval ${index + 1}`, {
      status: 'running',
      activityRunStatus: 'waiting',
      pendingRuntimeRequest: { id: 'r1', kind: 'command', createdAt: minutesAgo(30 - index) },
    }),
  );
  await mockT3(page, { ...inboxSnapshot, snapshot: { ...inboxSnapshot.snapshot, threads } });
  await page.goto('/');
  await pair(page);

  const button = page.locator('[data-focusable="agents-inbox"]');
  await expect(button).toHaveAccessibleName('Inbox 13 waiting for you');
  await button.click();
  await page
    .getByRole('dialog', { name: 'Inbox' })
    .getByRole('button', { name: /^Approval 13,/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Approval 13' })).toBeVisible();
  await expect(
    page.locator('.conversation [data-focusable="agent-decision-accept"]'),
  ).toBeFocused();

  // No shelf card to return to, so Back lands on the Inbox button.
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
});

test('the inbox panel moves, opens and closes with the remote on its own', async ({ page }) => {
  await page.route('**/inbox-standalone.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><div id="root"></div><script type="module" src="/tests/inbox-standalone.tsx"></script>',
    }),
  );
  await page.goto('/inbox-standalone.html');
  const inbox = page.getByRole('dialog', { name: 'Inbox' });
  await expect(inbox.getByRole('button', { name: /^approve,/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(inbox.getByRole('button', { name: /^finished,/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(inbox.getByRole('button', { name: /^finished,/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).toHaveAttribute('data-log', 'open finished;close;');
});

test('going back up a tall group keeps its first row in view', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 600 });
  await page.route('**/inbox-standalone.html?tall', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><div id="root"></div><script type="module" src="/tests/inbox-standalone.tsx"></script>',
    }),
  );
  await page.goto('/inbox-standalone.html?tall');
  const first = page.getByRole('dialog', { name: 'Inbox' }).getByRole('button', { name: /^ask0,/ });
  await expect(first).toBeFocused();
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowUp');
  await expect(first).toBeFocused();
  await expect(first).toBeInViewport({ ratio: 1 });
});
