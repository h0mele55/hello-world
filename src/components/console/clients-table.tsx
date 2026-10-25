'use client';

import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import type { ClientRow } from '@/lib/console/queries';
import { ConsoleTable, consoleColumns } from './console-table';

const column = consoleColumns<ClientRow>();

export function ClientsTable({ clients }: { clients: ClientRow[] }) {
  const t = useTranslations('console.clients');
  const format = useFormatter();
  const columns = column.columns([
    column.accessor('name', {
      header: t('columns.name'),
      sortFn: 'alphanumeric',
      cell: (info) => (
        <Link href={`/clients/${info.row.original.id}`} className="font-medium text-content-emphasis hover:underline" data-testid="client-link">
          {info.getValue()}
        </Link>
      ),
    }),
    column.accessor('registrationNumber', { header: t('columns.registrationNumber'), sortFn: 'alphanumeric', cell: (info) => <code className="font-mono">{info.getValue()}</code> }),
    column.accessor('country', { header: t('columns.country'), sortFn: 'alphanumeric' }),
    column.accessor('engagements', { header: t('columns.engagements'), sortFn: 'basic', enableGlobalFilter: false }),
    column.accessor('inProgress', {
      header: t('columns.inProgress'),
      sortFn: 'basic',
      enableGlobalFilter: false,
      cell: (info) => (info.getValue() > 0 ? <StatusBadge variant="info">{info.getValue()}</StatusBadge> : <span className="text-content-muted">0</span>),
    }),
    column.accessor((row) => new Date(row.lastActivity), {
      id: 'lastActivity',
      header: t('columns.lastActivity'),
      sortFn: 'datetime',
      enableGlobalFilter: false,
      cell: (info) => format.dateTime(info.getValue(), { dateStyle: 'medium', timeZone: 'UTC' }),
    }),
  ]);

  return (
    <ConsoleTable
      data={clients}
      columns={columns}
      getRowId={(row) => row.id}
      initialSorting={[{ id: 'name', desc: false }]}
      empty={{ title: t('empty.title'), description: t('empty.description') }}
      searchLabel={t('search')}
      testId="clients-table"
    />
  );
}
