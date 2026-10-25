import { describe, expect, it } from 'vitest';
import { lastDays, lastMonths } from '@/lib/console/periods';

describe('the dashboard periods', () => {
  it('counts back whole UTC months across a year end, oldest first', () => {
    expect(lastMonths(new Date('2026-02-28T23:59:59Z'), 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('counts back UTC days across a month end and a leap day', () => {
    expect(lastDays(new Date('2028-03-02T00:30:00Z'), 4)).toEqual(['2028-02-28', '2028-02-29', '2028-03-01', '2028-03-02']);
  });

  it('reads the UTC date, not the local one', () => {
    // 23:30 UTC is already the next day east of Greenwich; the dashboard still calls it the 31st.
    expect(lastDays(new Date('2026-12-31T23:30:00Z'), 1)).toEqual(['2026-12-31']);
    expect(lastMonths(new Date('2026-12-31T23:30:00Z'), 1)).toEqual(['2026-12']);
  });
});
