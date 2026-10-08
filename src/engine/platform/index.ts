/**
 * What the engine does differently per OS, behind one interface. `enginePlatform()` picks the implementation for
 * this machine; engine code asks it instead of branching on `process.platform`. To support another OS, add a file
 * that implements `EnginePlatform` (types.ts) and map its `Os` in `IMPLEMENTATIONS`.
 */
import { type Os, osOf } from '@shared/platform';
import { posixPlatform } from './posix';
import type { EnginePlatform } from './types';
import { windowsPlatform } from './windows';

export type * from './types';

const IMPLEMENTATIONS: Record<Os, () => EnginePlatform> = {
  mac: () => posixPlatform('mac'),
  linux: () => posixPlatform('linux'),
  windows: () => windowsPlatform(),
};

let current: EnginePlatform | null = null;

/** The implementation for this machine. */
export function enginePlatform(): EnginePlatform {
  current ??= IMPLEMENTATIONS[osOf(process.platform)]();
  return current;
}
