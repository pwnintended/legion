/**
 * What the engine does differently per OS, behind one interface. `enginePlatform()` picks the implementation for
 * this machine; engine code asks it instead of branching on `process.platform`. To support another OS, add a file
 * that implements `EnginePlatform` (types.ts) and map its `Os` in `IMPLEMENTATIONS`.
 */
import { type Os, osOf } from '@shared/platform';
import { posixPlatform } from './posix';
import type { EnginePlatform } from './types';

export type * from './types';

const IMPLEMENTATIONS: Record<Os, () => EnginePlatform> = {
  mac: () => posixPlatform('mac'),
  linux: () => posixPlatform('linux'),
  // Not supported yet (docs/architecture.md §3). A Windows implementation needs PATHEXT lookup (`claude.exe`,
  // `codex.cmd`) and a shell that exists there; the POSIX one keeps the engine loading, nothing more.
  windows: () => posixPlatform('linux'),
};

let current: EnginePlatform | null = null;

/** The implementation for this machine. */
export function enginePlatform(): EnginePlatform {
  current ??= IMPLEMENTATIONS[osOf(process.platform)]();
  return current;
}
