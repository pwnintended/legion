/**
 * The terminal while Legion owns it: native selection by default; LEGION_MOUSE=1 captures the mouse so the wheel
 * scrolls the conversation. Ink drops mouse
 * reports before `useInput` sees them, so it reads from {@link Terminal.stdin}, a copy of the real stdin with the
 * reports taken out; wheel turns go to {@link Terminal.onWheel} instead.
 */
import { PassThrough } from 'node:stream';

/** What the UI needs of the terminal: the mouse mode around a child process, and the wheel. */
export interface TerminalModes {
  /** Turns mouse reporting on if opted in (Legion has the screen). */
  enter(): void;
  /** Turns it off (an editor or other child has the screen, or Legion is leaving). */
  leave(): void;
  /** Calls `listener` per wheel notch: -1 up, 1 down. Returns the unsubscribe. */
  onWheel(listener: (direction: -1 | 1) => void): () => void;
}

// SGR reports (`CSI < button ; x ; y M|m`), which the modes below ask for.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the reports start with ESC.
const MOUSE = /\u001B\[<(\d+);\d+;\d+[Mm]/g;
const MOUSE_ON = '\u001B[?1000h\u001B[?1006h';
const MOUSE_OFF = '\u001B[?1006l\u001B[?1000l';

/** `chunk` without its mouse reports, and the wheel notches among them (-1 up, 1 down). */
export function takeMouse(chunk: string): { rest: string; wheel: (-1 | 1)[] } {
  const wheel: (-1 | 1)[] = [];
  const rest = chunk.replace(MOUSE, (_, button: string) => {
    const b = Number(button);
    // Bit 64 marks the wheel (bit 0: down); 4, 8 and 16 are modifiers.
    if ((b & 64) !== 0 && (b & 128) === 0 && (b & 2) === 0) wheel.push((b & 1) === 1 ? 1 : -1);
    return '';
  });
  return { rest, wheel };
}

export class Terminal implements TerminalModes {
  /** Ink's input: a TTY-like stream that raw mode and ref/unref pass through to the real stdin. */
  readonly stdin: PassThrough & { isTTY: true; setRawMode(on: boolean): void; ref(): void; unref(): void };
  private readonly listeners = new Set<(direction: -1 | 1) => void>();
  private readonly output: NodeJS.WriteStream;
  private readonly mouse: boolean;
  private on = false;

  constructor(
    input: NodeJS.ReadStream = process.stdin,
    output: NodeJS.WriteStream = process.stdout,
    mouse = process.env.LEGION_MOUSE === '1',
  ) {
    this.output = output;
    this.mouse = mouse;
    input.setEncoding('utf8');
    let reading = false;
    const onData = (chunk: string) => {
      const { rest, wheel } = takeMouse(chunk);
      for (const direction of wheel) for (const listener of this.listeners) listener(direction);
      if (rest) stream.write(rest);
    };
    const stream = Object.assign(new PassThrough({ encoding: 'utf8' }), {
      isTTY: true as const,
      // Ink turns raw mode off to hand the terminal to a child process, and on exit: stop reading then, so the
      // child gets the keys and the process can end.
      setRawMode: (on: boolean) => {
        input.setRawMode(on);
        if (on === reading) return;
        reading = on;
        if (on) input.on('data', onData).resume();
        else input.off('data', onData).pause();
      },
      ref: () => input.ref(),
      unref: () => input.unref(),
    });
    this.stdin = stream;
  }

  enter(): void {
    if (this.on || !this.mouse) return;
    this.on = true;
    this.output.write(MOUSE_ON);
  }

  leave(): void {
    if (!this.on) return;
    this.on = false;
    this.output.write(MOUSE_OFF);
  }

  onWheel(listener: (direction: -1 | 1) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
