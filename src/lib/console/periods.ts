/**
 * The dashboard's periods: UTC months and days, so a figure does not move
 * with the reader's time zone. Pure, so the browser and the tests share it.
 */

/** The last `count` UTC months, oldest first, as YYYY-MM, ending with the month of `now`. */
export function lastMonths(now: Date, count: number): string[] {
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (count - 1 - i), 1)).toISOString().slice(0, 7));
}

/** The last `count` UTC days, oldest first, as YYYY-MM-DD, ending with the day of `now`. */
export function lastDays(now: Date, count: number): string[] {
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (count - 1 - i))).toISOString().slice(0, 10));
}
