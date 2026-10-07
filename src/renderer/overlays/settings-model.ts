/**
 * Pure helpers for the settings overlay: inline validation of typed values (mirrors the ranges in
 * `SettingsSchema`, shared/domain.ts) and small derived notes. Kept free of React so it is unit-tested.
 */
import type { EngineInfo } from '@shared/engine';

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** A whole number in [min, max]. */
export function parseWhole(text: string, min: number, max: number): Parsed<number> {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return { ok: false, message: `Enter a whole number from ${min} to ${max}.` };
  const value = Number(trimmed);
  if (value < min || value > max) return { ok: false, message: `Must be between ${min} and ${max}.` };
  return { ok: true, value };
}

/** A positive USD amount, or empty for "no limit". Accepts `$4`, `4.50`, `1,000`. */
export function parseBudget(text: string): Parsed<number | null> {
  const trimmed = text.trim().replace(/^\$/, '').replace(/,/g, '');
  if (trimmed === '') return { ok: true, value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed))
    return { ok: false, message: 'Enter an amount like 5 or 12.50, or leave empty.' };
  const value = Number(trimmed);
  if (value <= 0) return { ok: false, message: 'Must be more than $0, or empty for no limit.' };
  return { ok: true, value };
}

/** An absolute binary path, or empty to auto-detect from PATH. `~/` is allowed (the engine expands it). */
export function parseBinaryPath(text: string): Parsed<string | null> {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (!trimmed.startsWith('/') && !trimmed.startsWith('~/'))
    return { ok: false, message: 'Use an absolute path, e.g. /opt/homebrew/bin/claude.' };
  if (/\s$/.test(text) || trimmed.endsWith('/')) return { ok: false, message: 'Point at the binary, not a folder.' };
  return { ok: true, value: trimmed };
}

/** A model name, or empty for the CLI's default. */
export function parseModel(text: string): Parsed<string | null> {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (/\s/.test(trimmed)) return { ok: false, message: 'Model names have no spaces.' };
  return { ok: true, value: trimmed };
}

export interface EngineStatus {
  tone: 'ok' | 'warn' | 'bad' | 'idle';
  label: string;
  detail: string | null;
}

/** One-line status of a probed engine: installed? logged in? */
export function engineStatus(info: EngineInfo | undefined, enabled: boolean): EngineStatus {
  if (!enabled) return { tone: 'idle', label: 'disabled', detail: 'Runs will not use this engine.' };
  if (!info) return { tone: 'idle', label: 'not detected yet', detail: null };
  if (!info.installed) return { tone: 'bad', label: 'not found', detail: info.error };
  if (info.loggedIn === false) return { tone: 'warn', label: 'not logged in', detail: info.error };
  if (info.error) return { tone: 'warn', label: 'needs attention', detail: info.error };
  return {
    tone: 'ok',
    label: info.loggedIn ? 'logged in' : 'ready',
    detail: info.account,
  };
}
