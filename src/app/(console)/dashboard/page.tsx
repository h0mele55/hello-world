import { getTranslations } from 'next-intl/server';
import { Card } from '@inflect/ui/components/ui/card';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { Heading } from '@inflect/ui/components/ui/typography';
import { CountChart } from '@/components/console/count-chart';
import { ANCHOR_MONTHS, anchorsPerMonth, LOOKUP_DAYS, lookupsPerDay, writesByStatus } from '@/lib/console/dashboard';
import { requireUser } from '@/lib/page-auth';
import type { ChainWriteStatus } from '@/generated/prisma/enums';

const STATUSES = ['INTENT', 'BROADCAST', 'INDETERMINATE', 'FINAL', 'FAILED', 'SIMULATED'] as const satisfies readonly ChainWriteStatus[];
const STATUS_VARIANT = { INTENT: 'neutral', SIMULATED: 'info', BROADCAST: 'info', FINAL: 'success', FAILED: 'error', INDETERMINATE: 'warning' } as const satisfies Record<ChainWriteStatus, string>;

function Tile({ label, value, hint, testId, tone }: { label: string; value: number; hint: string; testId: string; tone?: 'warning' }) {
  return (
    <Card className="flex flex-col gap-tight" data-testid={testId} data-value={value}>
      <span className="text-sm text-content-muted">{label}</span>
      <span className={`text-3xl font-semibold tabular-nums ${tone === 'warning' && value > 0 ? 'text-content-warning' : 'text-content-emphasis'}`}>{value}</span>
      <span className="text-sm text-content-muted">{hint}</span>
    </Card>
  );
}

/** The firm's figures at a glance. Every number is a count over the firm's own rows. */
export default async function DashboardPage() {
  const user = await requireUser();
  const t = await getTranslations('console.dashboard');
  const tStatus = await getTranslations('anchoring.status');
  const [anchors, writes, lookups] = await Promise.all([anchorsPerMonth(user), writesByStatus(user), lookupsPerDay(user)]);
  const thisMonth = anchors.at(-1)!;
  const inFlight = writes.LIVE.INTENT + writes.LIVE.BROADCAST;
  const lookupTotal = lookups.reduce((sum, d) => sum + d.count, 0);

  return (
    <main className="flex flex-col gap-section">
      <Heading level={1}>{t('title')}</Heading>
      <div className="grid gap-default sm:grid-cols-2 lg:grid-cols-4">
        <Tile label={t('tiles.anchoredThisMonth')} value={thisMonth.ANCHOR} hint={t('tiles.anchoredThisMonthHint')} testId="tile-anchored" />
        <Tile label={t('tiles.inFlight')} value={inFlight} hint={t('tiles.inFlightHint')} testId="tile-in-flight" />
        <Tile label={t('tiles.indeterminate')} value={writes.LIVE.INDETERMINATE} hint={t('tiles.indeterminateHint')} testId="tile-indeterminate" tone="warning" />
        <Tile label={t('tiles.lookups')} value={lookupTotal} hint={t('tiles.lookupsHint', { days: LOOKUP_DAYS })} testId="tile-lookups" />
      </div>

      <Card className="flex flex-col gap-default">
        <Heading level={2}>{t('anchors.title')}</Heading>
        <p className="text-content-muted">{t('anchors.description', { months: ANCHOR_MONTHS })}</p>
        <CountChart
          testId="anchors-chart"
          granularity="month"
          empty={t('anchors.empty')}
          points={anchors.map(({ month, ...counts }) => ({ period: month, counts }))}
          series={[
            { id: 'ANCHOR', label: t('anchors.ANCHOR'), colorClassName: 'text-brand-emphasis' },
            { id: 'ANCHOR_COPY', label: t('anchors.ANCHOR_COPY'), colorClassName: 'text-content-info' },
            { id: 'REVOKE', label: t('anchors.REVOKE'), colorClassName: 'text-content-warning' },
          ]}
        />
      </Card>

      <Card className="flex flex-col gap-default">
        <Heading level={2}>{t('writes.title')}</Heading>
        <p className="text-content-muted">{t('writes.description')}</p>
        <div className="overflow-x-auto">
          <table className="data-table" data-testid="writes-by-status">
            <thead>
              <tr>
                <th scope="col">{t('writes.status')}</th>
                <th scope="col">{t('writes.live')}</th>
                <th scope="col">{t('writes.dryRun')}</th>
              </tr>
            </thead>
            <tbody>
              {STATUSES.map((status) => (
                <tr key={status} data-status={status}>
                  <td>
                    <StatusBadge variant={STATUS_VARIANT[status]}>{tStatus(status)}</StatusBadge>
                  </td>
                  <td className="tabular-nums" data-mode="LIVE">
                    {writes.LIVE[status]}
                  </td>
                  <td className="tabular-nums" data-mode="DRY_RUN">
                    {writes.DRY_RUN[status]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="flex flex-col gap-default">
        <Heading level={2}>{t('lookups.title')}</Heading>
        <p className="text-content-muted">{t('lookups.description', { days: LOOKUP_DAYS })}</p>
        <CountChart
          testId="lookups-chart"
          granularity="day"
          empty={t('lookups.empty')}
          points={lookups.map(({ day, count }) => ({ period: day, counts: { lookups: count } }))}
          series={[{ id: 'lookups', label: t('lookups.series'), colorClassName: 'text-brand-emphasis' }]}
        />
      </Card>
    </main>
  );
}
