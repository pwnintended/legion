/**
 * Opening a terminal tile's pty: re-attach to the engine terminal the tile opened before (its id is kept in
 * the tile's params, so a remount — scrolling the column far away, switching layout mode or run — gets the
 * same shell back with its scrollback), or open a new one by target when there is none or it is gone.
 */
import type { RpcInput, RpcOutput, TerminalTarget } from '@shared/rpc';
import { type CallOptions, RpcError } from '@shared/rpc-transport';

export type OpenCall = (
  input: RpcInput<'terminals.open'>,
  options: CallOptions,
) => Promise<RpcOutput<'terminals.open'>>;

export interface Opened {
  terminalId: string;
  /** Our end of the data channel (the other end went to the engine). */
  port: MessagePort;
  /** True when this attached to the terminal `terminalId` named (false = a new process). */
  reattached: boolean;
}

/** The engine no longer has that terminal (reaped after its detached TTL, closed, engine restarted). */
function isGone(error: unknown): boolean {
  return error instanceof RpcError && (error.code === 'not_found' || error.code === 'failed_precondition');
}

export async function openOrAttach(
  call: OpenCall,
  spec: { target: TerminalTarget; terminalId: string | null; cols: number; rows: number },
  channel: () => MessageChannel = () => new MessageChannel(),
): Promise<Opened> {
  const { target, terminalId, cols, rows } = spec;
  if (terminalId) {
    const ch = channel();
    try {
      const opened = await call({ target, cols, rows, terminalId }, { transfer: [ch.port2] });
      return { terminalId: opened.terminalId, port: ch.port1, reattached: opened.terminalId === terminalId };
    } catch (error) {
      ch.port1.close();
      if (!isGone(error)) throw error;
    }
  }
  const ch = channel();
  try {
    const opened = await call({ target, cols, rows, terminalId: null }, { transfer: [ch.port2] });
    return { terminalId: opened.terminalId, port: ch.port1, reattached: false };
  } catch (error) {
    ch.port1.close();
    throw error;
  }
}
