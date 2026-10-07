/** Small helpers shared by every process. */

export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Exhaustiveness check for discriminated unions. */
export function assertNever(value: never, message = 'unexpected value'): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

/** Exponential backoff with a cap: base * 2^attempt, clamped to max. */
export function backoffMs(attempt: number, baseMs = 500, maxMs = 30_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
}

/** Keep the last `maxChars` characters of a string (for logs / tool output tails). */
export function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `…${text.slice(text.length - maxChars + 1)}`;
}
