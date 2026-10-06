import type { LegionBridge } from '@shared/bridge';

declare global {
  interface Window {
    /** Exposed by src/preload/index.ts. */
    readonly legion: LegionBridge;
  }
}
