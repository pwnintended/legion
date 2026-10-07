import type { Run } from '@shared/domain';
import { describe, expect, it } from 'vitest';
import { NEW, reconcile } from './state';

const runs = Object.fromEntries(
  [
    ['a', 10, 50],
    ['b', 20, 40],
    ['c', 30, 60],
  ].map(([id, createdAt, updatedAt]) => [id, { id, createdAt, updatedAt } as unknown as Run]),
);

describe('reconcile', () => {
  it('starts with the most recently updated conversation as the master', () => {
    expect(reconcile([], ['a', 'b', 'c'], runs)).toEqual(['c', 'a', 'b']);
  });
  it('keeps the stored order and adds newcomers to the end of the stack, oldest first', () => {
    expect(reconcile(['b'], ['a', 'b', 'c'], runs)).toEqual(['b', 'a', 'c']);
  });
  it('drops what left the board but keeps the new tile', () => {
    expect(reconcile([NEW, 'a', 'b'], ['b'], runs)).toEqual([NEW, 'b']);
  });
  it('drops duplicates', () => {
    expect(reconcile(['a', 'b', 'a'], ['a', 'b'], runs)).toEqual(['a', 'b']);
  });
  it('returns the same array when nothing changed', () => {
    const order = ['a', 'b'];
    expect(reconcile(order, ['b', 'a'], runs)).toBe(order);
  });
});
