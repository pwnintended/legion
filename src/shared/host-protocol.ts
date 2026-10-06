/**
 * Messages between Electron main and the engine utilityProcess (over `process.parentPort`).
 * Renderer traffic does NOT go through here: main hands the engine one end of a MessageChannelMain per
 * renderer (`connect`) and the RPC runs directly between renderer and engine.
 */

export type MainToEngineMessage =
  /** A new renderer connection; the port is in `event.ports[0]`. */
  | { type: 'connect'; clientId: string }
  /** Close the DB and exit. */
  | { type: 'shutdown' };

export type EngineToMainMessage =
  | { type: 'ready'; pid: number; dataDir: string }
  /** Native notification (main decides whether the window is focused). */
  | { type: 'notify'; title: string; body: string; runId: string | null }
  /** Dock badge: number of open inbox items. */
  | { type: 'badge'; count: number }
  /** Keep the system awake while agents run. */
  | { type: 'power'; preventSleep: boolean };

/** Env vars main passes to the engine. */
export const ENGINE_ENV = {
  /** Data directory (always set by main; defaults to ~/Library/Application Support/Legion). */
  home: 'LEGION_HOME',
  /** App version, for app.info. */
  version: 'LEGION_VERSION',
} as const;
