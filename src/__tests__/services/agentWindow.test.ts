import { computeVnDayWindow, isValidDateString, resolveFeaturedDate } from '../../services/agentWindow';

describe('isValidDateString', () => {
  it('accepts a well-formed real calendar date', () => {
    expect(isValidDateString('2026-09-18')).toBe(true);
  });

  it('accepts a leap-day date in a leap year', () => {
    expect(isValidDateString('2028-02-29')).toBe(true);
  });

  it('rejects a leap-day date in a non-leap year', () => {
    expect(isValidDateString('2026-02-29')).toBe(false);
  });

  it('rejects an out-of-range day for a 30-day month', () => {
    expect(isValidDateString('2026-04-31')).toBe(false);
  });

  it('rejects month 13', () => {
    expect(isValidDateString('2026-13-01')).toBe(false);
  });

  it('rejects malformed strings', () => {
    expect(isValidDateString('2026/09/18')).toBe(false);
    expect(isValidDateString('18-09-2026')).toBe(false);
    expect(isValidDateString('2026-9-18')).toBe(false);
    expect(isValidDateString('not-a-date')).toBe(false);
    expect(isValidDateString('')).toBe(false);
  });
});

describe('resolveFeaturedDate', () => {
  it('defaults to yesterday (VN) when no date param is given', () => {
    const resolved = resolveFeaturedDate(undefined);
    expect(resolved).not.toBeNull();
    expect(resolved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns the override date when it is a valid calendar date', () => {
    expect(resolveFeaturedDate('2026-09-18')).toBe('2026-09-18');
  });

  it('returns null for an invalid override date', () => {
    expect(resolveFeaturedDate('2026-02-30')).toBeNull();
    expect(resolveFeaturedDate('not-a-date')).toBeNull();
  });
});

describe('computeVnDayWindow', () => {
  it('computes the exact UTC boundaries from the api-contracts.md example', () => {
    const { start, end } = computeVnDayWindow('2026-09-18');
    expect(start.toISOString()).toBe('2026-09-17T17:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-18T17:00:00.000Z');
  });

  it('spans exactly 24 hours', () => {
    const { start, end } = computeVnDayWindow('2026-09-18');
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  // ── Window edges: 23:59 vs 00:00 VN ────────────────────────────────────────
  it('includes a timestamp at 23:59:59 VN on the target date within that date\'s window', () => {
    const { start, end } = computeVnDayWindow('2026-09-18');
    const lateNightVn = new Date('2026-09-18T23:59:59+07:00');
    expect(lateNightVn.getTime() >= start.getTime()).toBe(true);
    expect(lateNightVn.getTime() < end.getTime()).toBe(true);
  });

  it('includes a timestamp at exactly 00:00:00 VN on the target date within that date\'s window (inclusive start)', () => {
    const { start, end } = computeVnDayWindow('2026-09-18');
    const midnightVn = new Date('2026-09-18T00:00:00+07:00');
    expect(midnightVn.getTime()).toBe(start.getTime());
    expect(midnightVn.getTime() < end.getTime()).toBe(true);
  });

  it('excludes a timestamp at 00:00:00 VN on the NEXT date (exclusive end)', () => {
    const { end } = computeVnDayWindow('2026-09-18');
    const nextMidnightVn = new Date('2026-09-19T00:00:00+07:00');
    expect(nextMidnightVn.getTime()).toBe(end.getTime());
    // The window end is exclusive — a caller must use `< end`, not `<= end`.
  });

  it('excludes a timestamp at 23:59:59 VN on the day BEFORE the target date', () => {
    const { start } = computeVnDayWindow('2026-09-18');
    const previousLateNightVn = new Date('2026-09-17T23:59:59+07:00');
    expect(previousLateNightVn.getTime() < start.getTime()).toBe(true);
  });
});
