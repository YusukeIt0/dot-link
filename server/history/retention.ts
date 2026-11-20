export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
export type HistoryPeriod = '7d' | '1m' | '6m' | '1y';

const calendarMonths = { '1m': 1, '6m': 6, '1y': 12 } as const;

/** Exclusive expiry from the original source anchor, independent of the Mac's time zone. */
export function historyExpiry(anchorMs: number, period: HistoryPeriod): number {
  const date = new Date(anchorMs);
  if (date.getTime() !== anchorMs) throw new RangeError('Invalid history retention anchor');
  if (period === '7d') {
    date.setTime(anchorMs + SEVEN_DAYS_MS);
  } else {
    const day = date.getUTCDate();
    // Day zero of the following month is the last day of the target month.
    date.setUTCMonth(date.getUTCMonth() + calendarMonths[period] + 1, 0);
    date.setUTCDate(Math.min(day, date.getUTCDate()));
  }
  const expiresAt = date.getTime();
  if (!Number.isFinite(expiresAt)) throw new RangeError('Invalid history expiry');
  return expiresAt;
}
