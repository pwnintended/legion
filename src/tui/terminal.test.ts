import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Terminal, takeMouse } from './terminal.ts';

describe('takeMouse', () => {
  it('takes mouse reports out of the input and keeps the wheel notches', () => {
    expect(takeMouse('a\u001B[<64;10;5Mb\u001B[<65;1;1M\u001B[<0;3;4M\u001B[<0;3;4mc')).toEqual({
      rest: 'abc',
      wheel: [-1, 1],
    });
    // With Shift or Ctrl held, still the wheel.
    expect(takeMouse('\u001B[<68;1;1M\u001B[<81;1;1M').wheel).toEqual([-1, 1]);
    expect(takeMouse('\u001B[A')).toEqual({ rest: '\u001B[A', wheel: [] });
  });
});

describe('Terminal', () => {
  it('gives Ink the keys without the mouse, and reads stdin only while in raw mode', () => {
    const raw: boolean[] = [];
    const input = Object.assign(new PassThrough(), {
      setRawMode: (on: boolean) => raw.push(on),
      ref() {},
      unref() {},
    }) as unknown as NodeJS.ReadStream;
    const written: string[] = [];
    const output = { write: (s: string) => written.push(s) } as unknown as NodeJS.WriteStream;
    const terminal = new Terminal(input, output, true);
    const wheel: number[] = [];
    terminal.onWheel((d) => wheel.push(d));

    // Twice (Legion before Ink starts, then Ink): still read once.
    terminal.stdin.setRawMode(true);
    terminal.stdin.setRawMode(true);
    input.write('hi\u001B[<65;2;2M');
    expect(terminal.stdin.read()).toBe('hi');
    expect(wheel).toEqual([1]);
    terminal.stdin.setRawMode(false);
    input.write('later');
    expect(terminal.stdin.read()).toBeNull();
    expect(raw).toEqual([true, true, false]);

    terminal.enter();
    terminal.enter();
    terminal.leave();
    expect(written).toEqual(['\u001B[?1000h\u001B[?1006h', '\u001B[?1006l\u001B[?1000l']);
  });

  it('leaves mouse gestures to the terminal when mouse capture is off', () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const written: string[] = [];
    const output = { write: (s: string) => written.push(s) } as unknown as NodeJS.WriteStream;
    const terminal = new Terminal(input, output, false);
    terminal.enter();
    terminal.leave();
    expect(written).toEqual([]);
  });
});
