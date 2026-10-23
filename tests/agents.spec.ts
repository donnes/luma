import { test, expect, type Page, type Route, type WebSocketRoute } from '@playwright/test';

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

// `shellSent` and `threadSent` hold back those snapshots; `down()` takes the
// server off the network.
async function mockT3(
  page: Page,
  shell: object = shellSnapshot,
  { shellSent, threadSent }: { shellSent?: Promise<void>; threadSent?: Promise<void> } = {},
) {
  const commands: Record<string, unknown>[] = [];
  let up = true;
  const sockets: WebSocketRoute[] = [];
  // Sends later shell stream items, as the server does when threads change.
  let pushShell: (...items: object[]) => void = () => {};
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
    if (!up) return route.abort('connectionrefused');
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
    sockets.push(socket);
    const reply = (message: object) => socket.send(JSON.stringify(message));
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message._tag !== 'Request') return;
      const { id, tag, payload } = message;
      if (tag === 'orchestration.subscribeShell') {
        void (shellSent ?? Promise.resolve()).then(() =>
          reply({ _tag: 'Chunk', requestId: id, values: [shell] }),
        );
        pushShell = (...items) => reply({ _tag: 'Chunk', requestId: id, values: items });
      } else if (tag === 'orchestration.subscribeThread')
        void (threadSent ?? Promise.resolve()).then(() =>
          reply({ _tag: 'Chunk', requestId: id, values: [threadSnapshot] }),
        );
      else if (tag === 'server.getConfig')
        reply({ _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value: {} } });
      else if (tag === 'orchestration.dispatchCommand') {
        commands.push(payload);
        reply({ _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value: { sequence: 6 } } });
      }
    });
  });
  const down = async () => {
    up = false;
    for (const socket of sockets) await socket.close();
  };
  return { commands, down, pushShell: (...items: object[]) => pushShell(...items) };
}

test('the T3 Code app opens to pairing, then OK approves the waiting agent', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { commands } = await mockT3(page);
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

test('Samsung Back closes the connection dialog without leaving the app', async ({ page }) => {
  await mockT3(page);
  await page.goto('/');
  await pair(page);
  const connection = page.locator('[data-focusable="agents-connection"]');
  await connection.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.evaluate(() => {
    const init = { key: 'Unidentified', keyCode: 10009, bubbles: true, cancelable: true };
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', init));
  });
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(connection).toBeVisible();
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

test('Menu opens the inbox over any page, the remote moves through it and OK opens a thread', async ({
  page,
}) => {
  await mockT3(page, inboxSnapshot);
  await page.goto('/');
  await pair(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await settings.focus();

  await page.keyboard.press('ContextMenu');
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

  // Back and Menu close it, and focus goes back to where it was.
  await expect(inbox.getByRole('button').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(inbox).toBeHidden();
  await expect(settings).toBeFocused();
  await expect(page.getByRole('region', { name: 'Luma settings', exact: true })).toBeVisible();
  await page.keyboard.press('ContextMenu');
  await expect(inbox).toBeVisible();
  await page.keyboard.press('ContextMenu');
  await expect(inbox).toBeHidden();
  await expect(settings).toBeFocused();

  // Down crosses from Needs you into Done; OK opens that thread.
  await page.keyboard.press('ContextMenu');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(inbox.getByRole('button', { name: /^Fix settings scrolling/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(inbox).toBeHidden();
  await expect(
    page.getByRole('heading', { name: 'Fix settings scrolling from wider gutter areas' }),
  ).toBeVisible();
});

test('a request past the shelf opens from the inbox with its approval', async ({ page }) => {
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

  await page.keyboard.press('ContextMenu');
  const inbox = page.getByRole('dialog', { name: 'Inbox' });
  await inbox.getByRole('button', { name: /^Approval 13,/ }).click();
  await expect(page.getByRole('heading', { name: 'Approval 13' })).toBeVisible();
  const accept = page.locator('.conversation [data-focusable="agent-decision-accept"]');
  await expect(accept).toBeFocused();

  // Over the conversation, Back closes only the inbox.
  await page.keyboard.press('ContextMenu');
  await expect(inbox).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(inbox).toBeHidden();
  await expect(accept).toBeFocused();
});

test('without a pairing the inbox still opens and says where to pair', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('ContextMenu');
  const inbox = page.getByRole('dialog', { name: 'Inbox' });
  await expect(inbox).toContainText('Bring your agents to the TV.');
  await expect(inbox).toContainText('Open T3 Code from Luma’s Home or Apps to pair.');
  await page.keyboard.press('Escape');
  await expect(inbox).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open Netflix', exact: true })).toBeFocused();
});

test('Samsung Tools and the red key open the inbox, Samsung Back closes it', async ({ page }) => {
  await page.goto('/');
  const netflix = page.getByRole('button', { name: 'Open Netflix', exact: true });
  await expect(netflix).toBeFocused();
  // A keyboard can't send these codes; send them the way the TV does.
  const press = (keyCode: number) =>
    page.evaluate((keyCode) => {
      const init = { key: 'Unidentified', keyCode, bubbles: true, cancelable: true };
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', init));
    }, keyCode);
  const inbox = page.getByRole('dialog', { name: 'Inbox' });
  for (const open of [10135, 403]) {
    await press(open);
    await expect(inbox).toBeVisible();
    await press(10009);
    await expect(inbox).toBeHidden();
  }
  await expect(netflix).toBeFocused();
});

test('Menu opens the inbox from a text field, where M still types', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Find an app' });
  await search.focus();
  await page.keyboard.type('m');
  await expect(search).toHaveValue('m');
  await page.keyboard.press('ContextMenu');
  const inbox = page.getByRole('dialog', { name: 'Inbox' });
  await expect(inbox).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(inbox).toBeHidden();
  await expect(search).toBeFocused();
});

test('rows that arrive over the Agents page keep focus from the page behind', async ({ page }) => {
  let send = () => {};
  await mockT3(page, shellSnapshot, {
    shellSent: new Promise((resolve) => (send = resolve)),
    // Nothing re-renders the panel after the page's deferred focus.
    threadSent: new Promise(() => {}),
  });
  await page.goto('/');
  await pair(page);
  await expect(page.locator('main')).toContainText('Connecting to workstation…');
  await page.keyboard.press('ContextMenu');
  const inbox = page.getByRole('dialog', { name: 'Inbox' });
  await expect(inbox).toContainText('Connecting to workstation…');

  send();
  const row = inbox.getByRole('button', { name: /^Browser tests for the Agents tile,/ });
  await expect(row).toBeVisible();
  await expect(page.locator('main .spotlight')).toBeVisible();
  await expect(row).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(inbox).toBeHidden();
  await expect(page.locator('.conversation')).toBeVisible();
});

test('offline, the inbox says so above the threads it last saw', async ({ page }) => {
  const { down } = await mockT3(page, inboxSnapshot);
  await page.goto('/');
  await pair(page);
  await page.keyboard.press('ContextMenu');
  const inbox = page.getByRole('dialog', { name: 'Inbox' });
  const row = inbox.getByRole('button', { name: /^Run the agents inbox browser tests,/ });
  await expect(row).toBeFocused();
  await expect(inbox.getByRole('status')).toHaveCount(0);

  await down();
  await expect(inbox.getByRole('status')).toHaveText(/T3 Code is out of reach\./);
  await expect(row).toBeFocused();
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
  await page.keyboard.press('ContextMenu');
  await expect(page.locator('body')).toHaveAttribute('data-log', 'open finished;close;close;');
});

test('rows that arrive after the panel opened take focus', async ({ page }) => {
  await page.route('**/inbox-standalone.html?late', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><div id="root"></div><script type="module" src="/tests/inbox-standalone.tsx"></script>',
    }),
  );
  await page.goto('/inbox-standalone.html?late');
  const inbox = page.getByRole('dialog', { name: 'Inbox' });
  await expect(inbox).toContainText('Connecting…');
  await expect(inbox.getByRole('button', { name: /^approve,/ })).toBeFocused();
});

test('the list scrolls a tall group with the remote and back to its first row', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 600 });
  // As tall as the window, the way an overlay window is, so the list scrolls.
  await page.route('**/inbox-standalone.html?tall', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><div id="root" style="height: 100vh"></div><script type="module" src="/tests/inbox-standalone.tsx"></script>',
    }),
  );
  await page.goto('/inbox-standalone.html?tall');
  const inbox = page.getByRole('dialog', { name: 'Inbox' });
  const first = inbox.getByRole('button', { name: /^ask0,/ });
  const later = inbox.getByRole('button', { name: /^ask12,/ });
  await expect(first).toBeFocused();
  await expect(later).not.toBeInViewport();
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown');
  await expect(later).toBeFocused();
  await expect(later).toBeInViewport({ ratio: 1 });
  await expect(first).not.toBeInViewport();
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowUp');
  await expect(first).toBeFocused();
  await expect(first).toBeInViewport({ ratio: 1 });
});

test('an agent that newly needs you shows a toast, except where the agents page shows it', async ({
  page,
}) => {
  const { pushShell } = await mockT3(page);
  await page.goto('/');
  // Pairing lands on the agents page with the waiting agent in the spotlight;
  // what was already waiting doesn't alert.
  await pair(page);
  await expect(
    page.getByRole('heading', { name: 'Browser tests for the Agents tile' }),
  ).toBeVisible();
  const toast = page.locator('.agent-toast');
  const waiting = (sequence: number, id: string, title: string, request: string) => ({
    kind: 'thread.updated',
    sequence,
    location: 'active',
    thread: inboxThread(id, 'p1', title, {
      status: 'running',
      activityRunStatus: 'waiting',
      pendingRuntimeRequest: { id: request, kind: 'user_input', createdAt: minutesAgo(0) },
    }),
  });

  // Several agents asking in one update show one after another, except the
  // agent on screen, which would come between them if it alerted.
  pushShell(
    waiting(6, 'thread-2', 'Second opinion on the overlay', 'r6'),
    waiting(7, threadId, 'Browser tests for the Agents tile', 'r5'),
    waiting(8, 'thread-3', 'Pick a name for the release', 'r7'),
  );
  await expect(toast).toHaveCount(1);
  await expect(toast.locator('strong')).toHaveText('Second opinion on the overlay');
  await expect(toast.locator('strong')).toHaveText('Pick a name for the release', {
    timeout: 8000,
  });
  await expect(toast.locator('.agent-toast-headline')).toHaveText(
    'Needs you · asked a questionworkstation',
  );
  await expect(toast.locator('small')).toHaveText('luma');
  // Fully shown once it has slid in, then gone after a few seconds.
  await expect(toast).toHaveCSS('opacity', '1');
  await expect(toast).toBeHidden({ timeout: 8000 });
});

const asking = (sequence: number, id: string, title: string, request: string | null) => ({
  kind: 'thread.updated',
  sequence,
  location: 'active',
  thread: inboxThread(id, 'p1', title, {
    status: 'running',
    activityRunStatus: request ? 'waiting' : 'running',
    pendingRuntimeRequest: request && {
      id: request,
      kind: 'user_input',
      createdAt: minutesAgo(0),
    },
  }),
});

test('a queued alert whose request was answered meanwhile never shows', async ({ page }) => {
  const { pushShell } = await mockT3(page);
  await page.goto('/');
  await pair(page);
  await expect(
    page.getByRole('heading', { name: 'Browser tests for the Agents tile' }),
  ).toBeVisible();
  const toast = page.locator('.agent-toast');
  pushShell(
    asking(6, 'thread-2', 'Second opinion on the overlay', 'r6'),
    asking(7, 'thread-3', 'Pick a name for the release', 'r7'),
  );
  await expect(toast.locator('strong')).toHaveText('Second opinion on the overlay');
  // Answered elsewhere while the first alert is on screen.
  pushShell(asking(8, 'thread-3', 'Pick a name for the release', null));
  await expect(toast.filter({ hasText: 'Second opinion on the overlay' })).toHaveCount(0, {
    timeout: 8000,
  });
  expect(await toast.count()).toBe(0);
});

// The Fire TV shell with HomeGuard on. HomeGuard finds the alerts and keeps
// the history of alerted requests, which it shares with the page.
type FireTV = typeof window & {
  __homeGuard: boolean;
  __listening: boolean;
  __history: string;
  __historyFails?: boolean;
};
async function fireTV(page: Page, history: string[] | null = null) {
  await page.addInitScript((history) => {
    const w = window as FireTV;
    w.__homeGuard = true;
    w.__listening = false;
    w.__history = JSON.stringify(history);
    Object.assign(w, {
      LumaAndroid: {
        isTV: () => true,
        listApps: () => '{"apps":[]}',
        launchApp: () => '{}',
        exit: () => {},
        canAlertOverApps: () => w.__homeGuard,
        watchAgents: () => {},
        listenForAgentAlerts: () => (w.__listening = true),
        agentAlertHistory: () => {
          if (w.__historyFails) throw new Error('Reading the agent alert history failed');
          return w.__history;
        },
        saveAgentAlertHistory: (json: string) => (w.__history = json),
      },
    });
  }, history);
}

async function pairOnFireTV(page: Page) {
  await page.goto('/');
  await pair(page);
  await expect(
    page.getByRole('heading', { name: 'Browser tests for the Agents tile' }),
  ).toBeVisible();
  // The shell holds its alerts back until the page listens.
  await expect.poll(() => page.evaluate(() => (window as FireTV).__listening)).toBe(true);
}

/** What MainActivity runs for HomeGuard's events while Luma is in front. */
const fromHomeGuard = (page: Page, event: string, detail: unknown) =>
  page.evaluate(([event, detail]) => window.dispatchEvent(new CustomEvent(event, { detail })), [
    event,
    detail,
  ] as const);
const homeGuardAlert = (requestId: string, threadId: string, title: string) => ({
  requestId,
  threadId,
  headline: 'Needs you · asked a question',
  title,
  detail: 'luma',
  source: 'workstation',
});

test('on Fire TV, the page alerts itself once HomeGuard is turned off', async ({ page }) => {
  await fireTV(page, ['r1']);
  const { pushShell } = await mockT3(page);
  await pairOnFireTV(page);
  const toast = page.locator('.agent-toast');

  // HomeGuard finds this one and records it; the page leaves it to the shell.
  pushShell(asking(6, 'thread-2', 'Second opinion on the overlay', 'r6'));
  await expect(page.locator('.inbox-button-count')).toHaveText('2');
  await page.evaluate(() => Object.assign(window, { __history: '["r1","r6"]' }));

  // Turned off while Luma's page lives on, so the page alerts again.
  await page.evaluate(() => Object.assign(window, { __homeGuard: false }));
  pushShell(asking(7, 'thread-3', 'Pick a name for the release', 'r7'));
  // It's the first toast: the one HomeGuard took would have come before it.
  await expect(toast.locator('strong')).toHaveText('Pick a name for the release');
  // And the history it leaves HomeGuard for when it comes back has it.
  expect(JSON.parse(await page.evaluate(() => (window as FireTV).__history))).toEqual([
    'r1',
    'r6',
    'r7',
  ]);
});

test('on Fire TV, the page reads what HomeGuard recorded while briefly on', async ({ page }) => {
  await fireTV(page, ['r1']);
  const { pushShell } = await mockT3(page);
  await pairOnFireTV(page);
  const toast = page.locator('.agent-toast strong');

  // With HomeGuard off, the page alerts and keeps the history.
  await page.evaluate(() => Object.assign(window, { __homeGuard: false }));
  pushShell(asking(6, 'thread-2', 'Second opinion on the overlay', 'r5'));
  await expect(toast).toHaveText('Second opinion on the overlay');

  // HomeGuard comes on, alerts r6 itself and goes off again, all before the
  // page hears of r6. The page must not alert it a second time.
  await page.evaluate(() =>
    Object.assign(window, { __homeGuard: true, __history: '["r1","r5","r6"]' }),
  );
  await page.evaluate(() => Object.assign(window, { __homeGuard: false }));
  pushShell(
    asking(7, 'thread-3', 'Pick a name for the release', 'r6'),
    asking(8, 'thread-4', 'Review the overlay copy', 'r7'),
  );
  await expect(toast).toHaveText('Review the overlay copy', { timeout: 10000 });
});

test('on Fire TV, an alert waits out a history the shell cannot read', async ({ page }) => {
  await fireTV(page, ['r1']);
  const { pushShell } = await mockT3(page);
  await pairOnFireTV(page);
  await page.evaluate(() => Object.assign(window, { __homeGuard: false, __historyFails: true }));

  // Without its history the page can't tell what's new, so it holds off.
  pushShell(asking(6, 'thread-2', 'Second opinion on the overlay', 'r6'));
  await expect(page.locator('.inbox-button-count')).toHaveText('2');
  await expect(page.locator('.agent-toast')).toHaveCount(0);

  // Readable again: the next update alerts what it held off on.
  await page.evaluate(() => Object.assign(window, { __historyFails: false }));
  pushShell(asking(7, 'thread-3', 'Pick a name for the release', null));
  await expect(page.locator('.agent-toast strong')).toHaveText('Second opinion on the overlay');
});

test('on Fire TV, a queued alert leaves once answered even while the history is unreadable', async ({
  page,
}) => {
  await fireTV(page, ['r1']);
  const { pushShell } = await mockT3(page);
  await pairOnFireTV(page);
  await page.evaluate(() => Object.assign(window, { __homeGuard: false }));
  const toast = page.locator('.agent-toast');
  pushShell(
    asking(6, 'thread-2', 'Second opinion on the overlay', 'r6'),
    asking(7, 'thread-3', 'Pick a name for the release', 'r7'),
  );
  await expect(toast.locator('strong')).toHaveText('Second opinion on the overlay');

  // The second is answered while the history can't be read.
  await page.evaluate(() => Object.assign(window, { __historyFails: true }));
  pushShell(asking(8, 'thread-3', 'Pick a name for the release', null));
  await expect(toast).toBeHidden({ timeout: 8000 });
  await page.waitForTimeout(1000);
  await expect(toast).toHaveCount(0);
});

test('on Fire TV, a queued alert leaves once HomeGuard sees its request end', async ({ page }) => {
  await fireTV(page, ['r1']);
  await mockT3(page);
  await pairOnFireTV(page);
  const toast = page.locator('.agent-toast');

  // HomeGuard found both, and the page's own connection never saw r7 pending.
  await fromHomeGuard(
    page,
    'luma:agent-alert',
    homeGuardAlert('r6', 'thread-2', 'Second opinion on the overlay'),
  );
  await fromHomeGuard(
    page,
    'luma:agent-alert',
    homeGuardAlert('r7', 'thread-3', 'Pick a name for the release'),
  );
  await expect(toast.locator('strong')).toHaveText('Second opinion on the overlay');
  // Answered elsewhere while the first alert is on screen.
  await fromHomeGuard(page, 'luma:agent-alerts-ended', ['r7']);
  await expect(toast.filter({ hasText: 'Second opinion on the overlay' })).toHaveCount(0, {
    timeout: 8000,
  });
  expect(await toast.count()).toBe(0);
});

test('on Fire TV, an alert passed on twice shows once, and the next one follows', async ({
  page,
}) => {
  await fireTV(page, ['r1']);
  await mockT3(page);
  await pairOnFireTV(page);
  const toast = page.locator('.agent-toast');

  const first = homeGuardAlert('r6', 'thread-2', 'Second opinion on the overlay');
  await fromHomeGuard(page, 'luma:agent-alert', first);
  await fromHomeGuard(page, 'luma:agent-alert', first);
  await fromHomeGuard(
    page,
    'luma:agent-alert',
    homeGuardAlert('r7', 'thread-3', 'Pick a name for the release'),
  );
  await expect(toast.locator('strong')).toHaveText('Second opinion on the overlay');
  await expect(toast.locator('strong')).toHaveText('Pick a name for the release', {
    timeout: 8000,
  });
});
