# pty

node-pty sessions for terminals and session takeover (`terminals.*`, `sessions.takeover`). node-pty is
native: import it only here (never from code the unit tests load without a pty), lazily if possible.
Raw bytes use the MessagePort transferred with `terminals.open` (`ctx.ports[0]` in the handler), using
`TerminalMessage` from `@shared/rpc`; keep `@xterm/headless` + `@xterm/addon-serialize` mirrors for
scrollback hydration.
