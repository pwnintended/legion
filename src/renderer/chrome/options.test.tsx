import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { codeSpans, parseOption } from './options';

/** codeSpans as plain data: strings stay strings, code elements become { code }. */
function spans(text: string) {
  return codeSpans(text).map((node) =>
    isValidElement<{ children: string }>(node) ? { code: node.props.children } : node,
  );
}

describe('parseOption', () => {
  it('lifts a leading "Recommended:" into the flag', () => {
    expect(parseOption('Recommended: add a new `gates` object')).toEqual({
      text: 'add a new `gates` object',
      recommended: true,
    });
    expect(parseOption('recommended. Keep it')).toEqual({ text: 'Keep it', recommended: true });
  });

  it('lifts a trailing "(Recommended)"', () => {
    expect(parseOption('Radio rows (Recommended)')).toEqual({ text: 'Radio rows', recommended: true });
  });

  it('leaves other options, and a bare "Recommended", as written', () => {
    expect(parseOption('Warn by default.')).toEqual({ text: 'Warn by default.', recommended: false });
    expect(parseOption('Recommended')).toEqual({ text: 'Recommended', recommended: false });
    expect(parseOption('Recommended:')).toEqual({ text: 'Recommended:', recommended: false });
    expect(parseOption('The recommended: path')).toEqual({ text: 'The recommended: path', recommended: false });
  });
});

describe('codeSpans', () => {
  it('turns paired backticks into code', () => {
    expect(spans('Let `verify` take `{ name, run }` objects')).toEqual([
      'Let ',
      { code: 'verify' },
      ' take ',
      { code: '{ name, run }' },
      ' objects',
    ]);
  });

  it('keeps an unpaired or empty backtick span as typed', () => {
    expect(spans('a `b` c `d')).toEqual(['a ', { code: 'b' }, ' c ', '`d']);
    expect(spans('empty `` here')).toEqual(['empty ', '``', ' here']);
  });
});
