import { describe, expect, it } from 'vitest';

import { beginUnattendedTurn, isUnattendedTurn } from '../unattendedTurn';

describe('unattended turn marker', () => {
  it('is turn scoped, ref counted and idempotent on release', () => {
    expect(isUnattendedTurn('s')).toBe(false);
    const first = beginUnattendedTurn('s');
    const second = beginUnattendedTurn('s');
    expect(isUnattendedTurn('s')).toBe(true);
    first();
    expect(isUnattendedTurn('s')).toBe(true);
    second();
    expect(isUnattendedTurn('s')).toBe(false);
    first();
    expect(isUnattendedTurn('s')).toBe(false);
  });

  it('keeps sessions independent', () => {
    const release = beginUnattendedTurn('a');
    try {
      expect(isUnattendedTurn('b')).toBe(false);
    } finally {
      release();
    }
    expect(isUnattendedTurn('a')).toBe(false);
  });
});
