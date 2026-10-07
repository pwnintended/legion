# rpc

The engine side of `@shared/rpc` (architecture §10).

- `server.ts` — `createEngineRpcServer(ctx)`: the transport server, the `subscribe` procedure (replay from
  the event log, else `replayed: false`) and publishing of committed Store events to subscribers.
- `core.ts` — procedures implemented by the skeleton: `app.info`, `settings.get/set`, `runs.list`,
  `repos.inspect`, `repos.recent`.

Every other procedure answers `RpcError('not_implemented')` until a module registers it:

```ts
export function registerOrchestratorHandlers(server: EngineRpcServer, ctx: EngineContext, deps: ...) {
  server.implement('runs.get', ({ runId }) => ctx.store.runSnapshot(runId));
}
```

and is wired in `engine/index.ts` `startEngine`. Throw `RpcError` with a meaningful code
(`not_found`, `conflict`, `failed_precondition`, `bad_request`); anything else becomes `internal`.
