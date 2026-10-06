import type { AgentSession } from '@shared/engine';
import type { AgentEvent } from '@shared/events';

export interface EventCollector {
  readonly events: AgentEvent[];
  /** Resolves when the stream ends (after `exited`). */
  readonly done: Promise<void>;
  /** The next event of `type` after the last one returned by `next` (in stream order). */
  next<T extends AgentEvent['type']>(type: T, timeoutMs?: number): Promise<Extract<AgentEvent, { type: T }>>;
}

/** Consume `session.events` in the background (tests only). */
export function collectEvents(session: AgentSession): EventCollector {
  const events: AgentEvent[] = [];
  const waiters: { type: AgentEvent['type']; resolve: (e: AgentEvent) => void }[] = [];
  let cursor = 0;
  const check = () => {
    while (waiters.length > 0) {
      const waiter = waiters[0];
      if (!waiter) break;
      const index = events.findIndex((e, i) => i >= cursor && e.type === waiter.type);
      if (index < 0) break;
      waiters.shift();
      cursor = index + 1;
      waiter.resolve(events[index] as AgentEvent);
    }
  };
  const done = (async () => {
    for await (const event of session.events) {
      events.push(event);
      check();
    }
  })();
  return {
    events,
    done,
    next(type, timeoutMs = 120_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${type}; got ${events.map((e) => e.type).join(', ')}`)),
          timeoutMs,
        );
        waiters.push({
          type,
          resolve: (event) => {
            clearTimeout(timer);
            resolve(event as never);
          },
        });
        check();
      });
    },
  };
}
