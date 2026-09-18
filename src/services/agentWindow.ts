// Pure VN-calendar-day window helpers for GET /api/agent/featured. Reuses
// the existing todayVN()-style helper from RH-110/RH-111 (src/services/
// revenueReport.ts) per FR-17.12, rather than reimplementing VN "today".

import { todayVN } from './revenueReport';

const DATE_STRING_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Formats a Date (assumed to already represent a VN calendar day, see todayVN()) as YYYY-MM-DD. */
function formatDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Validates a `YYYY-MM-DD` string is both correctly formatted AND a real
 * calendar date (rejects e.g. "2026-02-30"), independent of any locale/TZ
 * DST behaviour (Vietnam has none, but this also guards against a typo
 * silently rolling over to a different date instead of failing validation).
 */
export function isValidDateString(value: string): boolean {
  if (!DATE_STRING_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

/**
 * Resolves the target VN calendar date for GET /api/agent/featured: the
 * `?date=YYYY-MM-DD` override if provided and valid, otherwise "yesterday"
 * in Asia/Ho_Chi_Minh (today, per todayVN(), minus one day). Returns null
 * when `dateParam` is provided but not a valid YYYY-MM-DD calendar date —
 * callers should respond 400 in that case.
 */
export function resolveFeaturedDate(dateParam: string | undefined): string | null {
  if (dateParam === undefined) {
    const today = todayVN();
    const yesterday = new Date(today);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    return formatDateString(yesterday);
  }
  return isValidDateString(dateParam) ? dateParam : null;
}

/**
 * Computes the UTC instant boundaries of a full VN calendar day for
 * `dateStr` (YYYY-MM-DD): VN midnight of that date through VN midnight of
 * the next date. Asia/Ho_Chi_Minh is a fixed UTC+7 offset (no DST), so the
 * explicit "+07:00" ISO offset is always correct — e.g. for "2026-09-18":
 * start = 2026-09-17T17:00:00Z, end = 2026-09-18T17:00:00Z, matching the
 * api-contracts.md example exactly.
 */
export function computeVnDayWindow(dateStr: string): { start: Date; end: Date } {
  const start = new Date(`${dateStr}T00:00:00+07:00`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}
