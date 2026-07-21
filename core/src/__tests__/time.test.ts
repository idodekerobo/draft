import { describe, expect, test } from 'bun:test';
import { isSameLocalDay, isToday } from '../time';

describe('isSameLocalDay', () => {
  test('same calendar day, different times', () => {
    expect(isSameLocalDay(new Date(2026, 5, 13, 1, 0), new Date(2026, 5, 13, 23, 0))).toBe(true);
  });

  test('different calendar days', () => {
    expect(isSameLocalDay(new Date(2026, 5, 12, 23, 59), new Date(2026, 5, 13, 0, 1))).toBe(false);
  });
});

describe('isToday', () => {
  const now = new Date(2026, 5, 13, 12, 0);

  test('timestamp from today', () => {
    expect(isToday(new Date(2026, 5, 13, 8, 0).toISOString(), now)).toBe(true);
  });

  test('timestamp from a prior day (multi-day daemon backlog)', () => {
    expect(isToday(new Date(2026, 5, 10, 8, 0).toISOString(), now)).toBe(false);
  });

  test('missing timestamp', () => {
    expect(isToday(undefined, now)).toBe(false);
  });

  test('malformed timestamp', () => {
    expect(isToday('not-a-date', now)).toBe(false);
  });
});
