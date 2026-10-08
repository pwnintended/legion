/**
 * What the main process does differently per OS, behind one interface. `mainPlatform()` picks the implementation
 * for this machine; nothing else in main branches on `process.platform`. To support another OS, add a file that
 * implements `MainPlatform` (types.ts) and map its `Os` in `IMPLEMENTATIONS`.
 */
import { type Os, osOf } from '@shared/platform';
import { linuxPlatform } from './linux';
import { macPlatform } from './mac';
import type { MainPlatform } from './types';

export * from './types';

const IMPLEMENTATIONS: Record<Os, () => MainPlatform> = {
  mac: macPlatform,
  linux: linuxPlatform,
  // Not supported yet (docs/architecture.md §3): Linux's choices (overlay controls, quit on last window) are
  // the Windows conventions too, so it runs, but nothing Windows-specific has been done or tested.
  windows: linuxPlatform,
};

let current: MainPlatform | null = null;

/** The implementation for this machine. */
export function mainPlatform(): MainPlatform {
  current ??= IMPLEMENTATIONS[osOf(process.platform)]();
  return current;
}
