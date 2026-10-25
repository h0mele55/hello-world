'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { VersionStatusBadge } from '@/components/reports/version-status-badge';
import type { ClientEngagementRow } from '@/lib/console/queries';
import { ConsoleTable, consoleColumns } from './console-table';

const column = consoleColumns<ClientEngagementRow>();

/** A client's engagements; each links to its version timeline. */
export function EngagementsTable({ engagements }: { engagements: ClientEngagementRow[] }) {
  const t = useTranslations('console.client');
  const tReports = useTranslations('reports');
  const columns = column.columns([
    column.accessor('engagementRef', {
      header: t('columns.engagementRef'),
      sortFn: 'alphanumeric',
      cell: (info) => (
        <Link href={`/reports/${info.row.original.id}`} className="font-medium text-content-emphasis hover:underline" data-testid="engagement-link">
          {info.getValue()}
        </Link>
      ),
    }),
    column.accessor('periodEnd', { header: t('columns.periodEnd'), sortFn: 'alphanumeric' }),
    column.accessor((row) => tReports(`reportTypes.${row.reportType}`), { id: 'reportType', header: t('columns.reportType'), sortFn: 'alphanumeric' }),
    column.accessor('versions', { header: t('columns.versions'), sortFn: 'basic', enableGlobalFilter: false }),
    column.accessor('latestStatus', {
      header: t('columns.latest'),
      enableSorting: false,
      enableGlobalFilter: false,
      cell: (info) => {
        const { latestStatus, latestVersion } = info.row.original;
        if (!latestStatus || latestVersion === null) return <span className="text-content-muted">{tReports('noVersions')}</span>;
        return (
          <span className="inline-flex items-center gap-tight">
            <span>{tReports('versionLabel', { version: latestVersion })}</span>
            <VersionStatusBadge status={latestStatus} />
          </span>
        );
      },
    }),
  ]);

  return (
    <ConsoleTable
      data={engagements}
      columns={columns}
      getRowId={(row) => row.id}
      initialSorting={[{ id: 'periodEnd', desc: true }]}
      empty={{ title: t('empty.title'), description: t('empty.description') }}
      searchLabel={engagements.length > 10 ? t('search') : undefined}
      testId="engagements-table"
    />
  );
}
