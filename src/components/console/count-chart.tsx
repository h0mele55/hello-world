'use client';

import { MotionConfig } from 'motion/react';
import { useFormatter, useTranslations } from 'next-intl';
import { Bars } from '@inflect/ui/components/ui/charts/bars';
import { TimeSeriesChart } from '@inflect/ui/components/ui/charts/time-series-chart';
import type { Series, TimeSeriesDatum } from '@inflect/ui/components/ui/charts/types';
import { XAxis } from '@inflect/ui/components/ui/charts/x-axis';
import { YAxis } from '@inflect/ui/components/ui/charts/y-axis';

type Counts = Record<string, number>;

export interface CountPoint {
  /** YYYY-MM for a month, YYYY-MM-DD for a day; always UTC. */
  period: string;
  counts: Counts;
}

export interface CountSeries {
  id: string;
  label: string;
  colorClassName: string;
}

const toDate = (period: string) => new Date(`${period.length === 7 ? `${period}-01` : period}T00:00:00.000Z`);

/**
 * Counts per month or per day as stacked bars, on the vendored chart. The
 * same figures follow as a table, for screen readers and for anyone who
 * wants the numbers rather than the shape.
 */
export function CountChart({ points, series, granularity, empty, testId }: { points: CountPoint[]; series: CountSeries[]; granularity: 'month' | 'day'; empty: string; testId: string }) {
  const t = useTranslations('console.dashboard');
  const format = useFormatter();
  const label = (date: Date) =>
    granularity === 'month' ? format.dateTime(date, { month: 'short', year: 'numeric', timeZone: 'UTC' }) : format.dateTime(date, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const total = points.reduce((sum, p) => sum + series.reduce((s, x) => s + (p.counts[x.id] ?? 0), 0), 0);

  const data: TimeSeriesDatum<Counts>[] = points.map((p) => ({ date: toDate(p.period), values: p.counts }));
  const chartSeries: Series<Counts>[] = series.map((s) => ({ id: s.id, isActive: true, colorClassName: s.colorClassName, valueAccessor: (d) => d.values[s.id] ?? 0 }));

  return (
    <figure className="flex flex-col gap-default" data-testid={testId} data-total={total}>
      {total === 0 ? (
        <p className="py-section text-center text-content-muted" data-testid={`${testId}-empty`}>
          {empty}
        </p>
      ) : (
        <div className="h-64" aria-hidden="true">
          {/* The vendored bars spring into place; a reader who asked for less motion gets them still. */}
          <MotionConfig reducedMotion="user">
            <TimeSeriesChart
              type="bar"
              data={data}
              series={chartSeries}
              className="relative h-full w-full"
              tooltipContent={(d) => `${label(d.date)}: ${series.map((s) => `${s.label} ${d.values[s.id] ?? 0}`).join(', ')}`}
            >
              <YAxis showGridLines integerTicks />
              <Bars />
              <XAxis tickFormat={label} />
            </TimeSeriesChart>
          </MotionConfig>
        </div>
      )}
      {series.length > 1 ? (
        <ul className="flex flex-wrap gap-default text-sm text-content-muted">
          {series.map((s) => (
            <li key={s.id} className="inline-flex items-center gap-tight">
              <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-sm bg-current ${s.colorClassName}`} />
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}
      <details>
        <summary className="cursor-pointer text-sm text-content-muted">{t('asTable')}</summary>
        <table className="data-table mt-compact" data-testid={`${testId}-table`}>
          <thead>
            <tr>
              <th scope="col">{granularity === 'month' ? t('month') : t('day')}</th>
              {series.map((s) => (
                <th key={s.id} scope="col">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.period} data-period={p.period}>
                <td>{label(toDate(p.period))}</td>
                {series.map((s) => (
                  <td key={s.id} data-series={s.id}>
                    {p.counts[s.id] ?? 0}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
