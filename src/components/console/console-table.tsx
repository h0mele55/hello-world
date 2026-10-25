'use client';

import {
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_includesString,
  flexRender,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowData,
  type SortingState,
} from '@tanstack/react-table';
import { useTranslations } from 'next-intl';
import { Button } from '@inflect/ui/components/ui/button';
import { Card } from '@inflect/ui/components/ui/card';
import { EmptyState } from '@inflect/ui/components/ui/empty-state';
import { Input } from '@inflect/ui/components/ui/input';

/**
 * The console's lists: TanStack Table inside the vendored Card (upstream's
 * DataTable is not vendored), searched, sorted and paged in the browser over
 * rows the server already scoped to the caller's firm.
 *
 * Declared once at module scope, as TanStack asks: a new features object per
 * render would rebuild the table's registry.
 */
export const consoleTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic, datetime: sortFn_datetime },
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns: { includesString: filterFn_includesString },
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
});

export type ConsoleTableFeatures = typeof consoleTableFeatures;
export const consoleColumns = <T extends RowData>() => createColumnHelper<ConsoleTableFeatures, T>();

const PAGE_SIZE = 20;

interface ConsoleTableProps<T extends RowData> {
  data: T[];
  // The column helper's own array type: each column keeps its value type, so the array cannot name one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: Array<ColumnDef<ConsoleTableFeatures, T, any>>;
  getRowId: (row: T) => string;
  initialSorting?: SortingState;
  /** Shown when there are no rows at all; a search that matches nothing has its own message. */
  empty: { title: string; description?: string };
  /** A search box over the columns that hold text; omit for a short list. */
  searchLabel?: string;
  testId: string;
}

export function ConsoleTable<T extends RowData>({ data, columns, getRowId, initialSorting = [], empty, searchLabel, testId }: ConsoleTableProps<T>) {
  const t = useTranslations('console.table');
  const table = useTable({
    features: consoleTableFeatures,
    columns,
    data,
    getRowId,
    globalFilterFn: 'includesString',
    initialState: { sorting: initialSorting, pagination: { pageIndex: 0, pageSize: PAGE_SIZE }, globalFilter: '' },
  });
  const search = (table.state.globalFilter as string | undefined) ?? '';
  const rows = table.getRowModel().rows;
  const matching = table.getFilteredRowModel().rows.length;
  const pageCount = Math.max(table.getPageCount(), 1);
  const pageIndex = table.state.pagination.pageIndex;

  if (data.length === 0) {
    return (
      <Card data-testid={testId} data-rows={0}>
        <EmptyState title={empty.title} description={empty.description} />
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-default" data-testid={testId} data-rows={matching}>
      {searchLabel ? (
        <Input
          type="search"
          aria-label={searchLabel}
          placeholder={searchLabel}
          value={search}
          onChange={(event) => table.setGlobalFilter(event.target.value)}
          data-testid={`${testId}-search`}
        />
      ) : null}
      {matching === 0 ? (
        <EmptyState
          variant="no-results"
          size="sm"
          title={t('noMatch.title')}
          description={t('noMatch.description', { search })}
          secondaryAction={{ label: t('noMatch.clear'), onClick: () => table.resetGlobalFilter(), 'data-testid': `${testId}-clear` }}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id}>
                  {group.headers.map((header) => {
                    const sorted = header.column.getIsSorted();
                    const label = flexRender(header.column.columnDef.header, header.getContext());
                    return (
                      <th key={header.id} scope="col" aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : header.column.getCanSort() ? 'none' : undefined}>
                        {header.column.getCanSort() ? (
                          <button type="button" className="inline-flex items-center gap-tight uppercase hover:text-content-emphasis" onClick={header.column.getToggleSortingHandler()} data-testid={`sort-${header.column.id}`}>
                            {label}
                            <span aria-hidden="true">{sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '↕'}</span>
                          </button>
                        ) : (
                          label
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid={`${testId}-row`}>
                  {row.getAllCells().map((cell) => (
                    <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-default text-sm text-content-muted">
        <span data-testid={`${testId}-count`}>{search ? t('matching', { count: matching, total: data.length }) : t('total', { count: data.length })}</span>
        {pageCount > 1 ? (
          <div className="flex items-center gap-tight">
            <Button variant="secondary" size="sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} data-testid={`${testId}-previous`}>
              {t('previous')}
            </Button>
            <span data-testid={`${testId}-page`}>{t('page', { page: pageIndex + 1, pages: pageCount })}</span>
            <Button variant="secondary" size="sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} data-testid={`${testId}-next`}>
              {t('next')}
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
