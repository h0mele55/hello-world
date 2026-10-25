import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Card } from '@inflect/ui/components/ui/card';
import { CopyButton } from '@inflect/ui/components/ui/copy-button';
import { EmptyState } from '@inflect/ui/components/ui/empty-state';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { Heading } from '@inflect/ui/components/ui/typography';
import { AUDIT_PAGE_SIZE, latestNightlyCheck, listAuditEvents, verifyFirmChain } from '@/lib/console/audit-log';
import { requireUser } from '@/lib/page-auth';

/**
 * The firm's audit log, newest first, and its hash chain re-derived on every
 * view: either intact, with its head hash, or broken at a named event. The
 * nightly check's last result sits beside it, and says so when it has not run.
 */
export default async function AuditLogPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  const user = await requireUser();
  const t = await getTranslations('auditLog');
  const format = await getFormatter();
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' });
  const beforeParam = Number((await searchParams).before);
  const before = Number.isInteger(beforeParam) && beforeParam > 1 ? beforeParam : undefined;
  const [chain, nightly, events] = await Promise.all([verifyFirmChain(user), latestNightlyCheck(user), listAuditEvents(user, before)]);
  const oldest = events.at(-1)?.seq;

  return (
    <main className="flex flex-col gap-section">
      <Heading level={1}>{t('title')}</Heading>
      <div className="grid gap-default lg:grid-cols-2">
        <Card className="flex flex-col gap-compact" data-testid="chain-now" data-ok={chain.ok}>
          <Heading level={2}>{t('now.title')}</Heading>
          {chain.ok ? (
            <>
              <StatusBadge variant="success">{t('intact')}</StatusBadge>
              <p>{t('now.intact', { count: chain.count })}</p>
              <div className="flex min-w-0 items-center gap-tight">
                <code className="truncate font-mono text-sm" title={chain.head} data-testid="chain-head">
                  {chain.head}
                </code>
                <CopyButton value={chain.head} label={t('head')} />
              </div>
            </>
          ) : (
            <>
              <StatusBadge variant="error">{t('broken')}</StatusBadge>
              <p role="alert" className="text-content-error" data-testid="chain-broken" data-seq={chain.seq} data-reason={chain.reason}>
                {t('now.broken', { seq: chain.seq, reason: t(`reasons.${chain.reason}`) })}
              </p>
            </>
          )}
        </Card>
        <Card className="flex flex-col gap-compact" data-testid="chain-nightly" data-state={nightly.state}>
          <Heading level={2}>{t('nightly.title')}</Heading>
          {nightly.state === 'NEVER_RUN' ? <p className="text-content-warning">{t('nightly.neverRun')}</p> : null}
          {nightly.state === 'INTACT' ? <p>{t('nightly.intact', { when: when(nightly.checkedAt), count: nightly.count })}</p> : null}
          {nightly.state === 'STALE' ? <p className="text-content-warning">{t('nightly.stale', { when: when(nightly.checkedAt) })}</p> : null}
          {nightly.state === 'BROKEN' ? (
            <p role="alert" className="text-content-error">
              {t('nightly.broken', { when: when(nightly.checkedAt), seq: nightly.seq, reason: t(`reasons.${nightly.reason}`) })}
            </p>
          ) : null}
          <p className="text-sm text-content-muted">{t('nightly.how')}</p>
        </Card>
      </div>

      <Card className="flex flex-col gap-default">
        <Heading level={2}>{t('events')}</Heading>
        {events.length === 0 ? (
          <EmptyState title={t('empty')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table" data-testid="audit-events">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">{t('columns.at')}</th>
                  <th scope="col">{t('columns.actor')}</th>
                  <th scope="col">{t('columns.action')}</th>
                  <th scope="col">{t('columns.subject')}</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.seq} data-testid="audit-event" data-seq={e.seq} data-action={e.action}>
                    <td className="tabular-nums">{e.seq}</td>
                    <td className="whitespace-nowrap">{when(e.at)}</td>
                    <td>{e.actor ?? <span className="text-content-muted">{t('worker')}</span>}</td>
                    <td>
                      <code className="font-mono text-sm">{e.action}</code>
                      <details className="mt-tight">
                        <summary className="cursor-pointer text-sm text-content-muted">{t('details')}</summary>
                        <pre className="mt-tight max-w-xl overflow-x-auto whitespace-pre-wrap break-all text-xs">{e.data}</pre>
                        <p className="mt-tight break-all font-mono text-xs text-content-muted">{t('hash', { hash: e.hash })}</p>
                      </details>
                    </td>
                    <td className="text-sm">
                      {e.subjectType} <code className="font-mono text-xs text-content-muted">{e.subjectId}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap gap-default text-sm">
          {before ? (
            <Link href="/audit-log" className="hover:underline" data-testid="audit-newest">
              {t('newest')}
            </Link>
          ) : null}
          {events.length === AUDIT_PAGE_SIZE && oldest && oldest > 1 ? (
            <Link href={`/audit-log?before=${oldest}`} className="hover:underline" data-testid="audit-older">
              {t('older')}
            </Link>
          ) : null}
        </div>
      </Card>
    </main>
  );
}
