import { dispatchCommand, type Command } from '../../../src/agents/commands.ts';
import {
  applyShellItem,
  applyThreadItem,
  emptyDetail,
  emptyShell,
  type Shell,
  type ThreadDetail,
} from '../../../src/agents/model.ts';
import {
  PairingError,
  socketUrl,
  websocketTicket,
  type Pairing,
} from '../../../src/agents/pairing.ts';
import { RpcError, RpcSocket } from '../../../src/agents/rpc.ts';
import type { ShellStreamItem, ThreadStreamItem } from '../../../src/agents/types.ts';

// One short-lived connection per voice request: ask, act, hang up. The
// service runs next to T3 Code, so there's no route juggling like on the TV.

// Every step has a deadline, so a T3 Code that accepts connections but never
// answers can't keep the Shortcut waiting.
const CONNECT_MS = 5000;
const SNAPSHOT_MS = 8000;
const DISPATCH_MS = 8000;

/** A failure that ends the request; `code` picks what Luma says. */
export class T3Unavailable extends Error {
  constructor(readonly code: 'unpaired' | 'expired' | 'unreachable') {
    super(code);
  }
}

const timeout = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref()),
  ]);

export class T3Session {
  private socket: Promise<RpcSocket> | null = null;
  private shellRequest: Promise<Shell> | null = null;
  private current: RpcSocket | null = null;

  constructor(private pairing: Pairing | null) {}

  private connect(): Promise<RpcSocket> {
    return (this.socket ??= (async () => {
      const pairing = this.pairing;
      if (!pairing) throw new T3Unavailable('unpaired');
      if (pairing.expiresAt && pairing.expiresAt < Date.now()) throw new T3Unavailable('expired');
      const route = pairing.pairedOn;
      const ticketRequest = new AbortController();
      try {
        return await timeout(
          (async () => {
            const ticket = await websocketTicket(route, pairing.token, ticketRequest.signal);
            const socket = new RpcSocket(socketUrl(route, ticket), () => {});
            this.current = socket;
            await socket.opened;
            return socket;
          })(),
          CONNECT_MS,
        );
      } catch (error) {
        ticketRequest.abort();
        if (error instanceof PairingError && error.code === 'expired')
          throw new T3Unavailable('expired');
        throw new T3Unavailable('unreachable');
      }
    })());
  }

  /** Every project and thread, as of the first snapshot. */
  shell(): Promise<Shell> {
    return (this.shellRequest ??= this.connect().then((socket) => {
      let shell = emptyShell();
      const ready = new Promise<Shell>((resolve, reject) => {
        const stream = socket.stream<ShellStreamItem>(
          'orchestration.subscribeShell',
          { requestCompletionMarker: true },
          (item) => {
            shell = applyShellItem(shell, item);
            if (!shell.ready) return;
            stream.cancel();
            resolve(shell);
          },
        );
        stream.done.then(() => reject(new Error('ended')), reject);
      });
      return timeout(ready, SNAPSHOT_MS).catch(() => {
        throw new T3Unavailable('unreachable');
      });
    }));
  }

  /** One thread's turn items and runtime requests. */
  async thread(threadId: string): Promise<ThreadDetail> {
    const socket = await this.connect();
    let detail = emptyDetail(threadId);
    const ready = new Promise<ThreadDetail>((resolve, reject) => {
      const stream = socket.stream<ThreadStreamItem>(
        'orchestration.subscribeThread',
        { threadId, requestCompletionMarker: true, acceptBoundedSnapshot: true },
        (item) => {
          detail = applyThreadItem(detail, item);
          if (!detail.ready) return;
          stream.cancel();
          resolve(detail);
        },
      );
      stream.done.then(() => reject(new Error('ended')), reject);
    });
    return timeout(ready, SNAPSHOT_MS).catch(() => {
      throw new T3Unavailable('unreachable');
    });
  }

  /** Commands T3 Code refuses throw `RpcError`; silence throws `T3Unavailable`. */
  async dispatch(command: Command) {
    const socket = await this.connect();
    await timeout(dispatchCommand(socket, command), DISPATCH_MS).catch((error) => {
      if (error instanceof RpcError) throw error;
      throw new T3Unavailable('unreachable');
    });
  }

  close() {
    this.current?.close();
  }
}
