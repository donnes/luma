import {
  applyShellItem,
  applyThreadItem,
  emptyDetail,
  emptyShell,
  type Shell,
  type ThreadDetail,
} from './model';
import {
  describe,
  loadPairing,
  pair,
  PairingError,
  savePairing,
  socketUrl,
  websocketTicket,
  type Pairing,
} from './pairing';
import { learnRoutes, type Route } from './routes';
import { RpcSocket } from './rpc';
import type { ApprovalDecision, DirectEndpoint, ShellStreamItem, ThreadStreamItem } from './types';

export type ConnectionStatus =
  | 'unpaired'
  | 'connecting'
  | 'connected'
  | 'offline'
  | 'expired'
  | 'paused';

export interface AgentsState {
  status: ConnectionStatus;
  pairing: Pairing | null;
  route: Route | null;
  shell: Shell;
  detail: ThreadDetail | null;
}

const PROBE_MS = 2500;
const OPEN_MS = 10000;
const SNAPSHOT_MS = 15000;
const UPGRADE_MS = 60000;
const COOLDOWN_MS = 5 * 60000;
const MAX_BACKOFF_MS = 60000;
/** Moving along the shelf shouldn't open a subscription for every card passed. */
const WATCH_DELAY_MS = 150;
const CACHED_DETAILS = 16;

function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // randomUUID needs a secure context; plain-HTTP previews don't have one.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Browsers block http:// from https:// pages. The Fire TV shell serves Luma
// from https://luma.local/ but explicitly allows mixed content.
const blocksPlainHttp = () => location.protocol === 'https:' && !('LumaAndroid' in window);

const timeout = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);

/**
 * Keeps one live connection to the paired T3 Code server.
 *
 * Connecting checks every saved address in parallel and uses the best one
 * that answers as the paired environment (LAN before Tailscale). While on a
 * worse route it re-checks the better ones every minute, so walking back into
 * the house moves the TV from Tailscale to the LAN.
 */
export class AgentsConnection {
  private state: AgentsState;
  private listeners = new Set<() => void>();
  private socket: RpcSocket | null = null;
  private attempt = 0;
  private backoff = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private upgradeTimer: ReturnType<typeof setInterval> | undefined;
  private connectedAt = 0;
  private cooldown = new Map<string, number>();
  private focusedThread: string | null = null;
  private threadStream: { cancel: () => void } | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  /** Last known detail per thread, so returning to a card shows it at once. */
  private details = new Map<string, ThreadDetail>();

  constructor() {
    const pairing = loadPairing();
    this.state = {
      status: pairing ? 'paused' : 'unpaired',
      pairing,
      route: null,
      shell: emptyShell(),
      detail: null,
    };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = () => this.state;

  private set(patch: Partial<AgentsState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  // --- Lifecycle -----------------------------------------------------------

  async pair(address: string, code: string, deviceLabel: string) {
    const pairing = await pair(address, code, deviceLabel);
    this.disconnect();
    this.set({ pairing, status: 'paused', shell: emptyShell(), detail: null, route: null });
    this.resume();
  }

  unpair() {
    this.disconnect();
    savePairing(null);
    this.set({ pairing: null, status: 'unpaired', shell: emptyShell(), detail: null, route: null });
  }

  /** Connects when Luma is visible. Safe to call repeatedly. */
  resume() {
    const { pairing, status } = this.state;
    if (!pairing || status === 'connecting' || status === 'connected') return;
    if (pairing.expiresAt && pairing.expiresAt < Date.now()) {
      this.set({ status: 'expired' });
      return;
    }
    this.backoff = 1000;
    void this.connect();
  }

  /** Drops the socket while another app is in front; the TV has better uses for it. */
  pause() {
    if (!this.state.pairing || this.state.status === 'expired') return;
    this.disconnect();
    this.set({ status: 'paused' });
  }

  private disconnect() {
    this.attempt++;
    clearTimeout(this.retryTimer);
    clearInterval(this.upgradeTimer);
    this.threadStream = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close('deliberate');
  }

  private async connect() {
    const pairing = this.state.pairing;
    if (!pairing) return;
    const attempt = ++this.attempt;
    clearTimeout(this.retryTimer);
    this.set({ status: 'connecting' });
    const now = Date.now();
    const routes = pairing.routes.filter((route) => (this.cooldown.get(route.url) ?? 0) < now);
    const answered = await Promise.all(
      routes.map((route) =>
        describe(route, PROBE_MS)
          .then((environment) => environment.environmentId === pairing.environmentId)
          .catch(() => false),
      ),
    );
    if (attempt !== this.attempt) return;
    // Routes that answered as this environment first, in rank order; silent
    // ones are a last resort since the check itself can be what's blocked.
    const order = [
      ...routes.filter((_, index) => answered[index]),
      ...routes.filter((_, index) => !answered[index]),
    ];
    for (const route of order) {
      try {
        await this.open(route, attempt);
        return;
      } catch (error) {
        if (attempt !== this.attempt) return;
        if (error instanceof PairingError && error.code === 'expired') {
          this.disconnect();
          this.set({ status: 'expired' });
          return;
        }
      }
    }
    this.set({ status: 'offline' });
    this.retry();
  }

  private retry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  private async open(route: Route, attempt: number) {
    const pairing = this.state.pairing!;
    const ticket = await websocketTicket(route, pairing.token);
    if (attempt !== this.attempt) return;
    const socket = new RpcSocket(socketUrl(route, ticket), (reason) =>
      this.onSocketClosed(socket, reason),
    );
    this.socket = socket;
    try {
      await timeout(socket.opened, OPEN_MS);
      let shell = emptyShell();
      let ready: () => void = () => {};
      const firstSnapshot = new Promise<void>((resolve) => (ready = resolve));
      socket
        .stream<ShellStreamItem>(
          'orchestration.subscribeShell',
          { requestCompletionMarker: true },
          (item) => {
            shell = applyShellItem(shell, item);
            if (!shell.ready) return;
            ready();
            if (this.socket === socket) this.set({ shell });
          },
        )
        .done.catch(() => {});
      await timeout(firstSnapshot, SNAPSHOT_MS);
    } catch (error) {
      if (this.socket === socket) this.socket = null;
      socket.close('deliberate');
      throw error;
    }
    if (attempt !== this.attempt) return;
    this.connectedAt = Date.now();
    this.set({ status: 'connected', route });
    if (this.focusedThread) this.watchThread(this.focusedThread);
    void this.learn(socket, route);
    clearInterval(this.upgradeTimer);
    this.upgradeTimer = setInterval(() => void this.upgrade(), UPGRADE_MS);
  }

  private onSocketClosed(socket: RpcSocket, reason: string) {
    if (this.socket !== socket || reason === 'deliberate') return;
    this.socket = null;
    this.threadStream = null;
    clearInterval(this.upgradeTimer);
    // A connection that held for a while resets the backoff; a flapping one doesn't.
    if (Date.now() - this.connectedAt > 30000) this.backoff = 1000;
    this.set({ status: 'connecting' });
    this.retry();
  }

  /** Saves every address the server reports, so the token keeps working away from home. */
  private async learn(socket: RpcSocket, route: Route) {
    try {
      const config = await socket.request<{ directEndpoints?: DirectEndpoint[] }>(
        'server.getConfig',
        {},
      );
      const pairing = this.state.pairing;
      if (!pairing || !Array.isArray(config?.directEndpoints)) return;
      const routes = learnRoutes(
        pairing.routes,
        config.directEndpoints,
        pairing.pairedOn,
        blocksPlainHttp(),
      );
      if (routes === pairing.routes) return;
      const next = { ...pairing, routes };
      savePairing(next);
      this.set({ pairing: next, route });
    } catch {
      /* Older servers or missing scopes: the paired address keeps working. */
    }
  }

  private async upgrade() {
    const { pairing, route, status } = this.state;
    if (!pairing || !route || status !== 'connected') return;
    const index = pairing.routes.findIndex((candidate) => candidate.url === route.url);
    const better = pairing.routes.slice(0, Math.max(index, 0));
    const now = Date.now();
    for (const candidate of better) {
      if ((this.cooldown.get(candidate.url) ?? 0) > now) continue;
      const environment = await describe(candidate, PROBE_MS).catch(() => null);
      if (environment?.environmentId !== pairing.environmentId) continue;
      if (this.state.route !== route) return;
      // If the switch doesn't land on the better route, don't keep trying it.
      this.cooldown.set(candidate.url, now + COOLDOWN_MS);
      this.disconnect();
      await this.connect();
      if (this.state.route?.url === candidate.url) this.cooldown.delete(candidate.url);
      return;
    }
  }

  // --- Thread detail -------------------------------------------------------

  /**
   * Streams full detail for the agent on screen, one thread at a time. The
   * cached detail shows immediately; the live subscription follows a beat later.
   */
  focus(threadId: string | null) {
    if (threadId === this.focusedThread) return;
    this.focusedThread = threadId;
    clearTimeout(this.watchTimer);
    this.threadStream?.cancel();
    this.threadStream = null;
    this.set({
      detail: threadId ? (this.details.get(threadId) ?? emptyDetail(threadId)) : null,
    });
    if (!threadId) return;
    this.watchTimer = setTimeout(() => {
      if (this.focusedThread === threadId && this.state.status === 'connected')
        this.watchThread(threadId);
    }, WATCH_DELAY_MS);
  }

  private remember(detail: ThreadDetail) {
    this.details.delete(detail.threadId);
    this.details.set(detail.threadId, detail);
    if (this.details.size > CACHED_DETAILS) {
      const oldest = this.details.keys().next();
      if (!oldest.done) this.details.delete(oldest.value);
    }
  }

  private watchThread(threadId: string) {
    const socket = this.socket;
    if (!socket) return;
    this.threadStream?.cancel();
    let detail = emptyDetail(threadId);
    const stream = socket.stream<ThreadStreamItem>(
      'orchestration.subscribeThread',
      { threadId, requestCompletionMarker: true, acceptBoundedSnapshot: true },
      (item) => {
        if (this.threadStream !== stream) return;
        detail = applyThreadItem(detail, item);
        if (!detail.ready) return;
        this.remember(detail);
        this.set({ detail });
      },
    );
    this.threadStream = stream;
    stream.done.catch(() => {});
  }

  // --- Commands ------------------------------------------------------------

  private dispatch(command: Record<string, unknown>) {
    if (!this.socket || this.state.status !== 'connected')
      return Promise.reject(new Error('offline'));
    return this.socket.request('orchestration.dispatchCommand', {
      ...command,
      commandId: uuid(),
    });
  }

  respond(threadId: string, requestId: string, decision: ApprovalDecision) {
    return this.dispatch({ type: 'runtime-request.respond', threadId, requestId, decision });
  }

  answer(threadId: string, requestId: string, answers: Record<string, string | string[]>) {
    return this.dispatch({ type: 'runtime-request.respond', threadId, requestId, answers });
  }

  /** The server decides whether a message steers or queues behind an active run. */
  send(threadId: string, text: string) {
    return this.dispatch({
      type: 'message.dispatch',
      createdBy: 'user',
      creationSource: 'web',
      threadId,
      messageId: uuid(),
      text,
      attachments: [],
      deliveryIntent: 'auto',
      dispatchMode: { type: 'start_immediately' },
    });
  }

  stop(threadId: string) {
    return this.dispatch({ type: 'thread.stop', threadId });
  }
}

let instance: AgentsConnection | undefined;
export const agentsConnection = () => (instance ??= new AgentsConnection());
