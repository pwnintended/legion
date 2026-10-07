/**
 * The confirm dialog for destructive actions (see app/confirm.ts). Above every overlay; Esc or a click on
 * the scrim declines; focus starts on the safe choice.
 */
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { answerConfirm, confirmStore } from '../app/confirm';
import { useReducedMotionPref } from '../app/prefs';
import { SPRING } from '../theme/motion';

export function ConfirmHost() {
  const request = useStore(confirmStore, (s) => s.request);
  return <AnimatePresence>{request ? <ConfirmDialog key={request.id} request={request} /> : null}</AnimatePresence>;
}

function ConfirmDialog({ request }: { request: NonNullable<ReturnType<typeof confirmStore.getState>['request']> }) {
  const reduced = useReducedMotionPref();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    // The dialog owns the keyboard: nothing reaches the app's bindings or the overlay underneath.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      answerConfirm(false);
    } else if (event.key === 'Tab') {
      const buttons = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
      const first = buttons[0];
      const last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };

  const hidden = reduced ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.985 };
  return (
    <div className="ovl-layer cf-layer" data-overlay-root>
      <motion.button
        type="button"
        tabIndex={-1}
        aria-label="Cancel"
        className="ovl-scrim"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.14 }}
        onClick={() => answerConfirm(false)}
      />
      <div className="ovl-place ovl-place-center" style={{ '--ovl-top': '150px' } as React.CSSProperties}>
        <motion.div
          ref={panelRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="cf-title"
          className="ovl ovl-center cf"
          data-testid="confirm"
          style={{ width: 440 }}
          initial={hidden}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ ...hidden, transition: { duration: 0.1 } }}
          transition={reduced ? { duration: 0.12 } : SPRING}
          onKeyDown={onKeyDown}
        >
          <div className="cf-body">
            <div id="cf-title" className="ovl-title">
              {request.title}
            </div>
            {request.body.map((p) => (
              <p key={p} className="cf-text">
                {p}
              </p>
            ))}
            {request.items?.length ? (
              <ul className="cf-items mono">
                {request.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="cf-actions">
            {request.cancelLabel === null ? null : (
              <button
                ref={cancelRef}
                type="button"
                className="btn btn-ghost"
                onClick={() => answerConfirm(false)}
                data-testid="confirm-cancel"
              >
                {request.cancelLabel ?? 'Cancel'}
              </button>
            )}
            <button
              ref={request.cancelLabel === null ? cancelRef : undefined}
              type="button"
              className={`btn ${request.tone === 'danger' ? 'btn-danger' : request.tone === 'warn' ? 'btn-warn' : 'btn-primary'}`}
              onClick={() => answerConfirm(true)}
              data-testid="confirm-ok"
            >
              {request.confirmLabel}
            </button>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
