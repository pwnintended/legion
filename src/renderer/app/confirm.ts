/**
 * A small "are you sure?" channel for destructive actions (start a task over, cancel a run to archive it).
 * `confirmAction(...)` resolves true/false once the user answers; the dialog (overlays/Confirm.tsx) sits
 * above everything, including an open overlay, and owns the keyboard while it is up.
 */
import { createStore } from 'zustand/vanilla';

export interface ConfirmRequest {
  title: string;
  /** Paragraphs explaining what will happen. */
  body: readonly string[];
  /** Optional list under the body (e.g. what is kept). */
  items?: readonly string[];
  confirmLabel: string;
  /** null = no cancel button (an acknowledgement, not a question). */
  cancelLabel?: string | null;
  /** Confirm button: `danger` red, `warn` peach, default the primary accent. */
  tone?: 'danger' | 'warn';
}

interface Pending extends ConfirmRequest {
  id: number;
  resolve: (ok: boolean) => void;
}

export const confirmStore = createStore<{ request: Pending | null }>(() => ({ request: null }));
let nextId = 1;

/** Ask; resolves true when confirmed. A new request dismisses (declines) one still open. */
export function confirmAction(request: ConfirmRequest): Promise<boolean> {
  confirmStore.getState().request?.resolve(false);
  return new Promise((resolve) => {
    const id = nextId++;
    confirmStore.setState({
      request: {
        ...request,
        id,
        resolve: (ok) => {
          if (confirmStore.getState().request?.id === id) confirmStore.setState({ request: null });
          resolve(ok);
        },
      },
    });
  });
}

export function answerConfirm(ok: boolean): void {
  confirmStore.getState().request?.resolve(ok);
}

export function isConfirmOpen(): boolean {
  return confirmStore.getState().request !== null;
}
