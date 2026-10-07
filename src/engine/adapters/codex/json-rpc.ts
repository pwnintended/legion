/**
 * Minimal JSON-RPC 2.0 peer for line-delimited transports (codex app-server speaks JSONL over stdio).
 * Transport-agnostic and pure: feed it lines with `receive()`, it writes lines through `write`.
 *
 * - Client → server requests with ids, per-request timeouts and abort signals.
 * - Notifications both ways.
 * - Server → client requests: `onRequest` may return a value or a promise (e.g. an approval that waits
 *   for the human); throwing a `JsonRpcError` replies with that error. Without a handler, or when the
 *   handler throws anything else, the peer still gets an error reply — a server request never hangs.
 *
 * Codex omits the `"jsonrpc": "2.0"` member on the wire; we do the same and accept either.
 */

export type RequestId = string | number;

export const JSON_RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

/** The connection closed (or was never usable) before a response arrived. */
export class JsonRpcClosedError extends Error {
  constructor(message = 'JSON-RPC connection closed') {
    super(message);
    this.name = 'JsonRpcClosedError';
  }
}

export class JsonRpcTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`JSON-RPC request ${method} timed out after ${timeoutMs} ms`);
    this.name = 'JsonRpcTimeoutError';
  }
}

export interface JsonRpcPeerOptions {
  /** Writes one serialized message (without the trailing newline; the peer appends it). */
  write(line: string): void;
  onNotification?(method: string, params: unknown): void;
  onRequest?(method: string, params: unknown, id: RequestId): unknown;
  /** Lines that are not valid JSON-RPC messages, and responses nobody waits for. */
  onProtocolError?(message: string, line: string): void;
  /** Default timeout for outgoing requests (ms). 0 = none. Default 60 s. */
  requestTimeoutMs?: number;
}

export interface RequestOptions {
  /** Overrides the default timeout; 0 = wait forever. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cleanup(): void;
}

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<RequestId, Pending>();
  private closedError: Error | null = null;

  constructor(private readonly options: JsonRpcPeerOptions) {}

  get isClosed(): boolean {
    return this.closedError !== null;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  request<R = unknown>(method: string, params?: unknown, opts: RequestOptions = {}): Promise<R> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (opts.signal?.aborted) return Promise.reject(opts.signal.reason ?? new Error('aborted'));
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? this.options.requestTimeoutMs ?? 60_000;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              cleanup();
              reject(new JsonRpcTimeoutError(method, timeoutMs));
            }, timeoutMs)
          : null;
      const onAbort = () => {
        this.pending.delete(id);
        cleanup();
        reject(opts.signal?.reason ?? new Error('aborted'));
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, cleanup });
      try {
        this.send(params === undefined ? { id, method } : { id, method, params });
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closedError) throw this.closedError;
    this.send(params === undefined ? { method } : { method, params });
  }

  /** Handle one incoming line. Blank lines are ignored. */
  receive(line: string): void {
    const text = line.trim();
    if (text === '') return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.options.onProtocolError?.('invalid JSON', line);
      return;
    }
    if (!isObject(message)) {
      this.options.onProtocolError?.('not a JSON-RPC message', line);
      return;
    }
    const { id, method } = message;
    const hasId = typeof id === 'string' || typeof id === 'number';
    if (typeof method === 'string') {
      if (hasId) this.handleRequest(method, message.params, id);
      else this.options.onNotification?.(method, message.params);
      return;
    }
    if (hasId && ('result' in message || 'error' in message)) {
      this.handleResponse(id, message, line);
      return;
    }
    this.options.onProtocolError?.('not a JSON-RPC message', line);
  }

  /** Reject every pending request; later requests reject immediately. Idempotent. */
  close(error: Error = new JsonRpcClosedError()): void {
    if (this.closedError) return;
    this.closedError = error;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      p.cleanup();
      p.reject(error);
    }
  }

  private handleResponse(id: RequestId, message: Record<string, unknown>, line: string): void {
    const pending = this.pending.get(id);
    if (!pending) {
      this.options.onProtocolError?.(`response for unknown request id ${String(id)}`, line);
      return;
    }
    this.pending.delete(id);
    pending.cleanup();
    if ('error' in message && message.error !== undefined && message.error !== null) {
      const error = isObject(message.error) ? message.error : {};
      const code = typeof error.code === 'number' ? error.code : JSON_RPC_ERROR.internalError;
      const text = typeof error.message === 'string' ? error.message : `${pending.method} failed`;
      pending.reject(new JsonRpcError(code, text, error.data));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleRequest(method: string, params: unknown, id: RequestId): void {
    const handler = this.options.onRequest;
    if (!handler) {
      this.replyError(id, new JsonRpcError(JSON_RPC_ERROR.methodNotFound, `unsupported request: ${method}`));
      return;
    }
    let result: unknown;
    try {
      result = handler(method, params, id);
    } catch (error) {
      this.replyError(id, error);
      return;
    }
    Promise.resolve(result).then(
      (value) => this.safeSend({ id, result: value ?? null }),
      (error: unknown) => this.replyError(id, error),
    );
  }

  private replyError(id: RequestId, error: unknown): void {
    const rpc =
      error instanceof JsonRpcError
        ? error
        : new JsonRpcError(JSON_RPC_ERROR.internalError, error instanceof Error ? error.message : String(error));
    this.safeSend({
      id,
      error:
        rpc.data === undefined
          ? { code: rpc.code, message: rpc.message }
          : { code: rpc.code, message: rpc.message, data: rpc.data },
    });
  }

  /** Replies to server requests may race with shutdown; dropping them then is fine. */
  private safeSend(message: Record<string, unknown>): void {
    if (this.closedError) return;
    try {
      this.send(message);
    } catch {
      // transport gone
    }
  }

  private send(message: Record<string, unknown>): void {
    this.options.write(JSON.stringify(message));
  }
}

/** Splits a byte-stream decoded as text into lines; keeps the trailing partial line for the next chunk. */
export class LineSplitter {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split('\n');
    this.buffer = parts.pop() ?? '';
    return parts.map((part) => (part.endsWith('\r') ? part.slice(0, -1) : part)).filter((part) => part !== '');
  }

  /** The remaining partial line, if any (call at end of stream). */
  flush(): string | null {
    const rest = this.buffer;
    this.buffer = '';
    return rest.trim() === '' ? null : rest;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
