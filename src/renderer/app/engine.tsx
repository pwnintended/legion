import type { ProcedureName, RpcInput, RpcOutput } from '@shared/rpc';
import { createContext, type ReactNode, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { ConnectionState } from './engine-connection';
import type { EngineClient } from './sync';

const EngineContext = createContext<EngineClient | null>(null);

export function EngineProvider({ connection, children }: { connection: EngineClient; children: ReactNode }) {
  return <EngineContext.Provider value={connection}>{children}</EngineContext.Provider>;
}

/** The engine client: `useEngine().call('tasks.retry', {...})`. Works the same in demo mode. */
export function useEngine(): EngineClient {
  const connection = useContext(EngineContext);
  if (!connection) throw new Error('useEngine must be used inside <EngineProvider>');
  return connection;
}

/** Connection status plus a generation that bumps on every new engine port. */
export function useConnectionState(): ConnectionState {
  const connection = useEngine();
  return useSyncExternalStore((listener) => connection.onStatus(listener), connection.getState);
}

export type QueryState<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'success'; data: T; error: null }
  | { status: 'error'; data: null; error: Error };

/**
 * One-shot RPC query, re-run when `key` changes. Live data belongs in the store (see hooks.ts); this is
 * meant for simple reads like `app.info` or `diff.get`.
 */
export function useRpcQuery<P extends ProcedureName>(
  method: P,
  input: RpcInput<P>,
  key: unknown = null,
): QueryState<RpcOutput<P>> {
  const connection = useEngine();
  const [state, setState] = useState<QueryState<RpcOutput<P>>>({ status: 'loading', data: null, error: null });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` controls refetching, input is captured.
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', data: null, error: null });
    connection.call(method, input).then(
      (data) => !cancelled && setState({ status: 'success', data, error: null }),
      (error: unknown) =>
        !cancelled &&
        setState({ status: 'error', data: null, error: error instanceof Error ? error : new Error(String(error)) }),
    );
    return () => {
      cancelled = true;
    };
  }, [connection, method, key]);
  return state;
}
