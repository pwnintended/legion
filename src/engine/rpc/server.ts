import type { ServerEvent } from '@shared/events';
import { MAX_REPLAY_EVENTS, type RpcContract, rpcContract } from '@shared/rpc';
import type { MethodOf } from '@shared/rpc-transport';
import { createRpcServer, type RpcHandler, type RpcServer } from '@shared/rpc-transport';
import type { EngineContext } from '../context';

export type EngineRpcServer = RpcServer<RpcContract, ServerEvent>;
export type EngineHandler<M extends MethodOf<RpcContract>> = RpcHandler<RpcContract, M, ServerEvent>;

/**
 * The engine's RPC server. Procedures without a handler answer `not_implemented`. The store's committed
 * events are published to every subscribed connection; `subscribe` replays from the event log.
 */
export function createEngineRpcServer(ctx: EngineContext): EngineRpcServer {
  const server = createRpcServer<RpcContract, ServerEvent>(rpcContract, {
    onError: (error, method) => ctx.log.error(`rpc ${method} failed`, error),
  });

  server.implement('subscribe', ({ sinceSeq }, { connection }) => {
    const headSeq = ctx.store.headSeq();
    if (sinceSeq > headSeq) {
      // The client saw a different (e.g. deleted) database: it must refetch.
      connection.startStream(headSeq, []);
      return { headSeq, replayed: false };
    }
    // seq is AUTOINCREMENT and the log is append-only, so head - since = number of missed events.
    if (sinceSeq === 0 || headSeq - sinceSeq > MAX_REPLAY_EVENTS) {
      connection.startStream(headSeq, []);
      return { headSeq, replayed: sinceSeq === headSeq };
    }
    connection.startStream(sinceSeq, ctx.store.eventsSince(sinceSeq, MAX_REPLAY_EVENTS));
    return { headSeq, replayed: true };
  });

  ctx.store.onEvents((events) => server.publish(events));
  return server;
}
