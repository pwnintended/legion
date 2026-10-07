/**
 * Double-fire guards for actions (approve, resolve, submit). An RPC resolving is not the end of an action:
 * the engine confirms it with an event (`inbox.updated`, `task.updated`, `run.updated`) a moment later, and
 * until then the UI still offers the action. A held key (auto-repeat) or a quick second press in that window
 * would send it again, which the engine rejects. So actions stay pending until the store shows the
 * confirming change (or a timeout passes, in case the event never comes).
 */
import type { DataState } from './data';
import { dataStore } from './store';

export const CONFIRM_TIMEOUT_MS = 8000;

/** Resolves true once `confirmed(data)` holds, or false after `timeoutMs`. */
export function whenData(confirmed: (data: DataState) => boolean, timeoutMs = CONFIRM_TIMEOUT_MS): Promise<boolean> {
  if (confirmed(dataStore.getState())) return Promise.resolve(true);
  return new Promise((resolve) => {
    const off = dataStore.subscribe((data) => {
      if (!confirmed(data)) return;
      clearTimeout(timer);
      off();
      resolve(true);
    });
    const timer = setTimeout(() => {
      off();
      resolve(false);
    }, timeoutMs);
  });
}

/** Runs one action at a time: calls made while one is in flight are dropped (resolve to false). */
export function singleFlight(): (action: () => Promise<unknown>) => Promise<boolean> {
  let busy = false;
  return async (action) => {
    if (busy) return false;
    busy = true;
    try {
      await action();
      return true;
    } finally {
      busy = false;
    }
  };
}

/** The inbox item is resolved (or gone) in the store. */
export const itemResolved = (itemId: string) => (data: DataState) => {
  const item = data.inbox[itemId];
  return !item || item.resolvedAt !== null;
};
