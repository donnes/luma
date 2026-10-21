// A minimal client for T3 Code's WebSocket API: Effect RPC with JSON
// serialization. Each text frame is one message or an array of them.
//
//   → {_tag:"Request", id, tag, payload, headers:[]}   ← {_tag:"Chunk", requestId, values}
//   → {_tag:"Ack", requestId}  (after every Chunk)     ← {_tag:"Exit", requestId, exit}
//   → {_tag:"Interrupt", requestId}                    ← {_tag:"Pong"}
//   → {_tag:"Ping"}                                    ← {_tag:"Defect", defect}
//
// Streams use ack-based backpressure: the server stops sending until each
// Chunk is acknowledged.

interface Pending {
  onChunk?: (values: unknown[]) => void;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

type ServerMessage =
  | { _tag: 'Chunk'; requestId: string; values: unknown[] }
  | {
      _tag: 'Exit';
      requestId: string;
      exit: { _tag: 'Success'; value: unknown } | { _tag: 'Failure'; cause: unknown };
    }
  | { _tag: 'Pong' }
  | { _tag: 'Defect'; defect: unknown };

export class RpcError extends Error {
  constructor(
    message: string,
    readonly tag?: string,
  ) {
    super(message);
  }
}

// Failure causes are arrays of {_tag:"Fail", error} / {_tag:"Die", defect}.
function failureMessage(cause: unknown): RpcError {
  const first = Array.isArray(cause) ? cause[0] : cause;
  const error = first?.error ?? first?.defect;
  if (error && typeof error === 'object')
    return new RpcError(String(error.message ?? error._tag ?? 'Request failed'), error._tag);
  return new RpcError(typeof error === 'string' ? error : 'Request failed');
}

const PING_MS = 5000;
const SILENCE_MS = 15000;

export class RpcSocket {
  private socket: WebSocket;
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private pinger: ReturnType<typeof setInterval> | undefined;
  private lastHeard = Date.now();
  private closed = false;
  readonly opened: Promise<void>;

  constructor(
    url: string,
    private onClose: (reason: string) => void,
  ) {
    this.socket = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), { once: true });
      this.socket.addEventListener('error', () => reject(new Error('socket')), { once: true });
    });
    this.socket.addEventListener('message', (event) => this.receive(event.data));
    this.socket.addEventListener('close', () => this.shutdown('closed'));
    this.pinger = setInterval(() => {
      if (Date.now() - this.lastHeard > SILENCE_MS) {
        this.close('silent');
        return;
      }
      this.send({ _tag: 'Ping' });
    }, PING_MS);
  }

  private send(message: object) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private receive(data: unknown) {
    this.lastHeard = Date.now();
    if (typeof data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    for (const message of (Array.isArray(parsed) ? parsed : [parsed]) as ServerMessage[]) {
      if (message._tag === 'Chunk') {
        const pending = this.pending.get(String(message.requestId));
        this.send({ _tag: 'Ack', requestId: message.requestId });
        pending?.onChunk?.(message.values);
      } else if (message._tag === 'Exit') {
        const id = String(message.requestId);
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (message.exit._tag === 'Success') pending?.resolve(message.exit.value);
        else pending?.reject(failureMessage(message.exit.cause));
      } else if (message._tag === 'Defect') {
        this.close('defect');
      }
    }
  }

  request<T>(tag: string, payload: object): Promise<T> {
    return this.start(tag, payload).done as Promise<T>;
  }

  /** Starts a stream. `cancel` interrupts it on the server. */
  stream<T>(tag: string, payload: object, onItem: (item: T) => void) {
    const { id, done } = this.start(tag, payload, (values) =>
      values.forEach((value) => onItem(value as T)),
    );
    return {
      done,
      cancel: () => {
        if (this.pending.delete(id)) this.send({ _tag: 'Interrupt', requestId: id });
      },
    };
  }

  private start(tag: string, payload: object, onChunk?: (values: unknown[]) => void) {
    const id = String(this.nextId++);
    const done = new Promise<unknown>((resolve, reject) => {
      if (this.closed) {
        reject(new RpcError('Disconnected'));
        return;
      }
      this.pending.set(id, { resolve, reject, onChunk });
      this.send({ _tag: 'Request', id, tag, payload, headers: [] });
    });
    return { id, done };
  }

  close(reason = 'closed') {
    if (this.socket.readyState <= WebSocket.OPEN) {
      this.send({ _tag: 'Eof' });
      this.socket.close();
    }
    this.shutdown(reason);
  }

  private shutdown(reason: string) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pinger);
    for (const pending of this.pending.values()) pending.reject(new RpcError('Disconnected'));
    this.pending.clear();
    this.onClose(reason);
  }
}
