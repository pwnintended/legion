/**
 * Transport-agnostic typed RPC over anything MessagePort-like (DOM `MessagePort`, Node
 * `worker_threads` ports, Electron `MessagePortMain` / `parentPort`).
 *
 * Wire format (structured clone, every message tagged `rpc: 1` so foreign messages are ignored):
 *   client → server  { rpc: 1, t: 'req', id, method, input }            (+ transferred ports)
 *   server → client  { rpc: 1, t: 'res', id, ok: true, output }
 *                    { rpc: 1, t: 'res', id, ok: false, error: { code, message, data } }
 *                    { rpc: 1, t: 'evt', events: E[] }                   (batched, ordered by seq)
 *
 * The server validates input and output with the contract's zod schemas. Push events are only sent to
 * connections that started a stream (`connection.startStream`, called by the `subscribe` handler) and
 * are coalesced into batches every `batchMs`.
 */
import { ZodError, type z } from 'zod';

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export const RPC_ERROR_CODES = [
  /** Input failed validation or is otherwise malformed. */
  'bad_request',
  'not_found',
  /** Compare-and-set failed / illegal status transition / stale version. */
  'conflict',
  /** The call is valid but the system is not in a state that allows it (e.g. engine not installed). */
  'failed_precondition',
  'not_implemented',
  'internal',
  'timeout',
  /** The port closed before a response arrived. */
  'disconnected',
  'unavailable',
] as const;
export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

export interface WireError {
  code: RpcErrorCode;
  message: string;
  data: unknown;
}

export class RpcError extends Error {
  override readonly name: string = 'RpcError';
  readonly code: RpcErrorCode;
  readonly data: unknown;

  constructor(code: RpcErrorCode, message: string, data: unknown = null) {
    super(message);
    this.code = code;
    this.data = data;
  }

  toWire(): WireError {
    return { code: this.code, message: this.message, data: this.data };
  }

  static fromWire(wire: WireError): RpcError {
    const code = (RPC_ERROR_CODES as readonly string[]).includes(wire.code) ? wire.code : 'internal';
    return new RpcError(code, wire.message, wire.data ?? null);
  }

  /** Normalize anything thrown by a handler into an RpcError. */
  static from(error: unknown): RpcError {
    if (error instanceof RpcError) return error;
    if (error instanceof ZodError) {
      return new RpcError('bad_request', error.issues.map(formatIssue).join('; '), error.issues);
    }
    const message = error instanceof Error ? error.message : String(error);
    return new RpcError('internal', message);
  }
}

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `${path}: ${issue.message}`;
}

// ---------------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------------

/** Minimal structural type covering DOM, worker_threads and Electron ports. */
export interface PortLike {
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
}

export interface MessageEndpoint {
  postMessage(data: unknown, transfer?: readonly unknown[]): void;
  /** Subscribe to incoming messages; returns an unsubscribe function. Starts the port if needed. */
  onMessage(listener: (data: unknown, ports: readonly unknown[]) => void): () => void;
  /** Called when the underlying port reports it closed (not all port types do). */
  onClose(listener: () => void): () => void;
  close(): void;
}

type Listener = (...args: unknown[]) => void;
interface EventTargetPort extends PortLike {
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
  start?(): void;
  close?(): void;
}
interface EmitterPort extends PortLike {
  on(type: string, listener: Listener): unknown;
  off?(type: string, listener: Listener): unknown;
  removeListener?(type: string, listener: Listener): unknown;
  start?(): void;
  close?(): void;
}

function isEndpoint(value: unknown): value is MessageEndpoint {
  return typeof value === 'object' && value !== null && 'onMessage' in value && 'onClose' in value;
}

/**
 * Wrap a port. Ports with `addEventListener` (DOM, worker_threads) deliver `MessageEvent`s; ports with
 * only `on` (Electron MessagePortMain / parentPort) deliver `{ data, ports }` objects.
 */
export function toEndpoint(port: PortLike | MessageEndpoint): MessageEndpoint {
  if (isEndpoint(port)) return port;
  const target = port as Partial<EventTargetPort & EmitterPort>;

  const add = (type: string, listener: Listener): (() => void) => {
    if (typeof target.addEventListener === 'function') {
      target.addEventListener(type, listener);
      return () => target.removeEventListener?.(type, listener);
    }
    if (typeof target.on === 'function') {
      target.on(type, listener);
      return () => {
        if (typeof target.off === 'function') target.off(type, listener);
        else target.removeListener?.(type, listener);
      };
    }
    throw new TypeError('toEndpoint: port has neither addEventListener nor on');
  };

  let started = false;
  return {
    postMessage(data, transfer) {
      if (transfer && transfer.length > 0) port.postMessage(data, transfer);
      else port.postMessage(data);
    },
    onMessage(listener) {
      const off = add('message', (event: unknown) => {
        const ev = event as { data?: unknown; ports?: readonly unknown[] } | undefined;
        listener(ev?.data, ev?.ports ? Array.from(ev.ports) : []);
      });
      if (!started) {
        started = true;
        target.start?.();
      }
      return off;
    },
    onClose(listener) {
      return add('close', () => listener());
    },
    close() {
      target.close?.();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------------------------

interface WireRequest {
  rpc: 1;
  t: 'req';
  id: number;
  method: string;
  input: unknown;
}
type WireResponse =
  | { rpc: 1; t: 'res'; id: number; ok: true; output: unknown }
  | { rpc: 1; t: 'res'; id: number; ok: false; error: WireError };
interface WireEvents {
  rpc: 1;
  t: 'evt';
  events: unknown[];
}

function isWire(data: unknown): data is { rpc: 1; t: string } {
  return typeof data === 'object' && data !== null && (data as { rpc?: unknown }).rpc === 1;
}

// ---------------------------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------------------------

export interface ProcedureSchema {
  input: z.ZodType;
  output: z.ZodType;
}
export type Contract = { readonly [method: string]: ProcedureSchema };
export type MethodOf<C extends Contract> = keyof C & string;
export type InputOf<C extends Contract, M extends MethodOf<C>> = z.input<C[M]['input']>;
export type ParsedInputOf<C extends Contract, M extends MethodOf<C>> = z.output<C[M]['input']>;
export type OutputOf<C extends Contract, M extends MethodOf<C>> = z.output<C[M]['output']>;
export type HandlerResultOf<C extends Contract, M extends MethodOf<C>> = z.input<C[M]['output']>;

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

export interface CallOptions {
  /** Ports (or other transferables) moved to the server along with the request. */
  transfer?: readonly unknown[];
  /** Overrides the client default; 0 = no timeout. */
  timeoutMs?: number;
}

export interface RpcClient<C extends Contract, E> {
  call<M extends MethodOf<C>>(method: M, input: InputOf<C, M>, options?: CallOptions): Promise<OutputOf<C, M>>;
  /** Push-event batches, in seq order. */
  onEvents(listener: (events: E[]) => void): () => void;
  /** Rejects pending calls with `disconnected` and stops listening. Closes the port if `closePort`. */
  close(options?: { closePort?: boolean }): void;
  readonly closed: boolean;
}

export interface RpcClientOptions {
  /** Default per-call timeout in ms; 0 (default) = none. */
  timeoutMs?: number;
}

export function createRpcClient<C extends Contract, E = unknown>(
  port: PortLike | MessageEndpoint,
  options: RpcClientOptions = {},
): RpcClient<C, E> {
  const endpoint = toEndpoint(port);
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: RpcError) => void;
      timer: ReturnType<typeof setTimeout> | null;
    }
  >();
  const eventListeners = new Set<(events: E[]) => void>();
  let nextId = 1;
  let closed = false;

  const settle = (id: number): ReturnType<typeof pending.get> => {
    const entry = pending.get(id);
    if (!entry) return undefined;
    pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    return entry;
  };

  const offMessage = endpoint.onMessage((data) => {
    if (!isWire(data)) return;
    if (data.t === 'res') {
      const res = data as WireResponse;
      const entry = settle(res.id);
      if (!entry) return;
      if (res.ok) entry.resolve(res.output);
      else entry.reject(RpcError.fromWire(res.error));
    } else if (data.t === 'evt') {
      const events = (data as WireEvents).events as E[];
      for (const listener of eventListeners) listener(events);
    }
  });

  const shutdown = (reason: string): void => {
    if (closed) return;
    closed = true;
    offMessage();
    offClose();
    for (const id of [...pending.keys()]) {
      settle(id)?.reject(new RpcError('disconnected', reason));
    }
  };
  const offClose = endpoint.onClose(() => shutdown('port closed'));

  return {
    get closed() {
      return closed;
    },
    call(method, input, callOptions = {}) {
      if (closed) return Promise.reject(new RpcError('disconnected', 'client is closed'));
      const id = nextId++;
      const timeoutMs = callOptions.timeoutMs ?? options.timeoutMs ?? 0;
      return new Promise((resolve, reject) => {
        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                settle(id)?.reject(new RpcError('timeout', `${method} timed out after ${timeoutMs} ms`));
              }, timeoutMs)
            : null;
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        const message: WireRequest = { rpc: 1, t: 'req', id, method, input };
        try {
          endpoint.postMessage(message, callOptions.transfer);
        } catch (error) {
          settle(id);
          reject(new RpcError('bad_request', `could not send ${method}: ${(error as Error).message}`));
        }
      });
    },
    onEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    close(closeOptions = {}) {
      shutdown('client closed');
      if (closeOptions.closePort) endpoint.close();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------

export interface RpcConnection<E> {
  readonly id: number;
  /** True once `startStream` was called. */
  readonly streaming: boolean;
  /** Seq of the last event queued for this connection. */
  readonly cursor: number;
  /**
   * Begin pushing events: sends `replay` immediately, then any published event with seq > cursor.
   * Calling it again restarts the stream at the new cursor.
   */
  startStream(cursor: number, replay: readonly E[]): void;
  /** Queue events for this connection only (bypasses the cursor filter). */
  push(events: readonly E[]): void;
  close(): void;
  onClose(listener: () => void): () => void;
}

export interface CallContext<E> {
  method: string;
  connection: RpcConnection<E>;
  /** Ports transferred with the request. */
  ports: readonly unknown[];
}

export type RpcHandler<C extends Contract, M extends MethodOf<C>, E> = (
  input: ParsedInputOf<C, M>,
  ctx: CallContext<E>,
) => HandlerResultOf<C, M> | Promise<HandlerResultOf<C, M>>;

export type RpcHandlers<C extends Contract, E> = { [M in MethodOf<C>]: RpcHandler<C, M, E> };

export interface RpcServerOptions<C extends Contract, E> {
  handlers?: Partial<RpcHandlers<C, E>>;
  /** Event coalescing window in ms (default 16). 0 = flush on the next macrotask. */
  batchMs?: number;
  /** Validate handler output against the contract (default true). */
  validateOutput?: boolean;
  /** Observability hook for failed calls (not called for expected client errors). */
  onError?: (error: unknown, method: string) => void;
}

export interface RpcServer<C extends Contract, E extends { seq: number }> {
  implement<M extends MethodOf<C>>(method: M, handler: RpcHandler<C, M, E>): void;
  isImplemented(method: MethodOf<C>): boolean;
  /** Attach a port; returns the connection (closed automatically when the port closes). */
  connect(port: PortLike | MessageEndpoint): RpcConnection<E>;
  /** Fan out events to every streaming connection (filtered by each connection's cursor). */
  publish(events: readonly E[]): void;
  readonly connections: ReadonlySet<RpcConnection<E>>;
  close(): void;
}

const EXPECTED_CODES: ReadonlySet<RpcErrorCode> = new Set([
  'bad_request',
  'not_found',
  'conflict',
  'failed_precondition',
  'not_implemented',
]);

export function createRpcServer<C extends Contract, E extends { seq: number }>(
  contract: C,
  options: RpcServerOptions<C, E> = {},
): RpcServer<C, E> {
  const handlers = new Map<string, RpcHandler<C, MethodOf<C>, E>>();
  for (const [method, handler] of Object.entries(options.handlers ?? {})) {
    if (handler) handlers.set(method, handler as RpcHandler<C, MethodOf<C>, E>);
  }
  const batchMs = options.batchMs ?? 16;
  const validateOutput = options.validateOutput ?? true;
  const connections = new Set<RpcConnection<E>>();
  /** Per-connection cursor-filtered publish. */
  const publishers = new Map<RpcConnection<E>, (events: readonly E[]) => void>();
  let nextConnectionId = 1;

  const dispatch = async (
    request: WireRequest,
    ctx: CallContext<E>,
  ): Promise<{ ok: true; output: unknown } | { ok: false; error: RpcError }> => {
    const schema = Object.hasOwn(contract, request.method) ? contract[request.method] : undefined;
    if (!schema) return { ok: false, error: new RpcError('not_found', `unknown method ${request.method}`) };
    const handler = handlers.get(request.method);
    if (!handler) {
      return { ok: false, error: new RpcError('not_implemented', `${request.method} is not implemented yet`) };
    }
    const parsed = schema.input.safeParse(request.input);
    if (!parsed.success) {
      return { ok: false, error: RpcError.from(parsed.error) };
    }
    let result: unknown;
    try {
      result = await handler(parsed.data as never, ctx);
    } catch (error) {
      const rpcError = RpcError.from(error);
      if (!EXPECTED_CODES.has(rpcError.code)) options.onError?.(error, request.method);
      return { ok: false, error: rpcError };
    }
    if (!validateOutput) return { ok: true, output: result };
    const out = schema.output.safeParse(result);
    if (!out.success) {
      const error = new RpcError(
        'internal',
        `invalid output from ${request.method}: ${out.error.issues.map(formatIssue).join('; ')}`,
      );
      options.onError?.(error, request.method);
      return { ok: false, error };
    }
    return { ok: true, output: out.data };
  };

  const connect = (port: PortLike | MessageEndpoint): RpcConnection<E> => {
    const endpoint = toEndpoint(port);
    const closeListeners = new Set<() => void>();
    let queue: E[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let streaming = false;
    let cursor = 0;
    let open = true;

    const send = (message: WireResponse | WireEvents): void => {
      if (!open) return;
      try {
        endpoint.postMessage(message);
      } catch (error) {
        if (message.t === 'res') {
          const fallback: WireResponse = {
            rpc: 1,
            t: 'res',
            id: message.id,
            ok: false,
            error: new RpcError('internal', `could not serialize response: ${(error as Error).message}`).toWire(),
          };
          endpoint.postMessage(fallback);
        } else {
          options.onError?.(error, 'publish');
        }
      }
    };

    const flush = (): void => {
      timer = null;
      if (queue.length === 0) return;
      const events = queue;
      queue = [];
      send({ rpc: 1, t: 'evt', events });
    };

    const enqueue = (events: readonly E[]): void => {
      if (!open || events.length === 0) return;
      queue.push(...events);
      if (timer === null) timer = setTimeout(flush, batchMs);
    };

    const connection: RpcConnection<E> = {
      id: nextConnectionId++,
      get streaming() {
        return streaming;
      },
      get cursor() {
        return cursor;
      },
      startStream(from, replay) {
        streaming = true;
        cursor = from;
        queue = [];
        const REPLAY_CHUNK = 1000;
        for (let i = 0; i < replay.length; i += REPLAY_CHUNK) {
          const chunk = replay.slice(i, i + REPLAY_CHUNK);
          send({ rpc: 1, t: 'evt', events: chunk });
        }
        const last = replay.at(-1);
        if (last && last.seq > cursor) cursor = last.seq;
      },
      push(events) {
        enqueue(events);
      },
      close() {
        if (!open) return;
        flush();
        open = false;
        if (timer) clearTimeout(timer);
        offMessage();
        offClose();
        connections.delete(connection);
        publishers.delete(connection);
        endpoint.close();
        for (const listener of closeListeners) listener();
      },
      onClose(listener) {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
    };

    const offMessage = endpoint.onMessage((data, ports) => {
      if (!isWire(data) || data.t !== 'req') return;
      const request = data as WireRequest;
      void dispatch(request, { method: request.method, connection, ports }).then((result) => {
        if (result.ok) send({ rpc: 1, t: 'res', id: request.id, ok: true, output: result.output });
        else send({ rpc: 1, t: 'res', id: request.id, ok: false, error: result.error.toWire() });
      });
    });
    const offClose = endpoint.onClose(() => connection.close());

    connections.add(connection);
    publishers.set(connection, (events) => {
      if (!streaming) return;
      const fresh = events.filter((event) => event.seq > cursor);
      const last = fresh.at(-1);
      if (!last) return;
      cursor = last.seq;
      enqueue(fresh);
    });
    return connection;
  };

  return {
    implement(method, handler) {
      handlers.set(method, handler as unknown as RpcHandler<C, MethodOf<C>, E>);
    },
    isImplemented(method) {
      return handlers.has(method);
    },
    connect,
    publish(events) {
      if (events.length === 0) return;
      for (const publishTo of publishers.values()) publishTo(events);
    },
    connections,
    close() {
      for (const connection of [...connections]) connection.close();
    },
  };
}
