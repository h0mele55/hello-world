import { getFormatter, getTranslations } from 'next-intl/server';
import { Card } from '@inflect/ui/components/ui/card';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { Heading } from '@inflect/ui/components/ui/typography';
import type { SessionUser } from '@/auth';
import type { RevocationStatus, VersionStatus } from '@/generated/prisma/enums';
import { getChainWriteMode } from '@/lib/anchoring/approve';
import { getRevocations } from '@/lib/anchoring/revocation';
import { mayDo } from '@/lib/roles';
import { RevocationActions } from './revocation-actions';
import { RevocationForm } from './revocation-form';

const STATUS_VARIANT = {
  REQUESTED: 'warning',
  APPROVED: 'info',
  SCHEDULED: 'warning',
  REVOKED: 'error',
  REJECTED: 'neutral',
  WITHDRAWN: 'neutral',
  CANCELLED: 'neutral',
} as const satisfies Record<RevocationStatus, string>;
const OPEN: readonly RevocationStatus[] = ['REQUESTED', 'APPROVED', 'SCHEDULED', 'REVOKED'];

/**
 * A version's revocation: the open request and what each person may do with
 * it, the form to ask for one, the revocation waiting out the registry's
 * delay, or the one in effect. Earlier requests that were turned down, taken
 * back or cancelled by the registry's owner stay listed.
 */
export async function RevocationPanel({ user, version }: { user: SessionUser; version: { id: string; version: number; status: VersionStatus; engagementRef: string } }) {
  const revocable = version.status === 'ANCHORED' || version.status === 'COMPLETE' || version.status === 'REVOKED';
  if (!revocable) return null;
  const t = await getTranslations('revocation');
  const format = await getFormatter();
  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  const revocations = await getRevocations(user, version.id);
  const current = revocations.find((r) => OPEN.includes(r.status));
  const earlier = revocations.filter((r) => r !== current);
  // The owner cancelling a revocation is news the firm must not miss: say it above the form.
  const lastCancelled = !current && revocations[0]?.status === 'CANCELLED';
  const dryRun = current?.status === 'REQUESTED' && mayDo(user.role, 'approve') ? (await getChainWriteMode(user)) === 'DRY_RUN' : false;

  const acts: ('approve' | 'reject' | 'withdraw')[] = [];
  if (current?.status === 'REQUESTED') {
    if (mayDo(user.role, 'approve') && current.requestedById !== user.id) acts.push('approve', 'reject');
    if (current.requestedById === user.id) acts.push('withdraw');
  }

  return (
    <Card className="flex flex-col gap-default" data-testid="revocation-panel" data-status={current?.status ?? 'NONE'}>
      <Heading level={2}>{t('title')}</Heading>
      {current ? (
        <div className="flex flex-col gap-compact" data-testid="revocation-current">
          <div className="flex flex-wrap items-center gap-tight">
            <StatusBadge variant={STATUS_VARIANT[current.status]}>{t(`statuses.${current.status}`)}</StatusBadge>
            <StatusBadge variant="neutral">{t(`reasons.${current.reason}`)}</StatusBadge>
          </div>
          <p>{t('requested', { who: current.requestedBy, when: when(current.requestedAt) })}</p>
          <blockquote className="whitespace-pre-wrap border-l-2 border-border-default pl-default text-content-default" data-testid="revocation-note-shown">
            {current.note}
          </blockquote>
          {current.status === 'REQUESTED' && acts.length === 0 ? <p className="text-content-muted">{t('waitingApprover')}</p> : null}
          {current.status === 'APPROVED' ? (
            <p className="text-content-muted" data-testid="revocation-queued">
              {t('queued', { who: current.approvedBy ?? '' })}
            </p>
          ) : null}
          {current.status === 'SCHEDULED' && current.effectiveAt ? (
            <p className="text-content-warning" data-testid="revocation-scheduled" data-effective-at={current.effectiveAt}>
              {t('scheduled', { when: when(current.effectiveAt) })}
            </p>
          ) : null}
          {current.status === 'REVOKED' && current.revokedAt ? (
            <p className="text-content-error" data-testid="revocation-final">
              {t('revoked', { when: when(current.revokedAt), reason: t(`reasons.${current.reason}`), code: current.code })}
            </p>
          ) : null}
          {acts.length > 0 ? <RevocationActions revocationId={current.id} acts={acts} dryRun={dryRun} /> : null}
        </div>
      ) : (
        <>
          {lastCancelled ? (
            <p className="text-content-warning" data-testid="revocation-cancelled">
              {t('cancelled')}
            </p>
          ) : null}
          <p className="text-content-muted">{t('intro')}</p>
          {mayDo(user.role, 'requestRevocation') ? <RevocationForm versionId={version.id} version={version.version} engagementRef={version.engagementRef} /> : <p className="text-content-muted">{t('adminOnly')}</p>}
        </>
      )}
      {earlier.length > 0 ? (
        <>
          <Heading level={3}>{t('history')}</Heading>
          <ul className="flex flex-col gap-tight text-sm" data-testid="revocation-history">
            {earlier.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-tight">
                <StatusBadge variant={STATUS_VARIANT[r.status]}>{t(`statuses.${r.status}`)}</StatusBadge>
                <span>{t(`reasons.${r.reason}`)}</span>
                <span className="text-content-muted">
                  {r.status === 'CANCELLED'
                    ? t('cancelledOn', { when: r.closedAt ? when(r.closedAt) : '' })
                    : t('closed', { who: r.closedBy ?? '', when: r.closedAt ? when(r.closedAt) : '' })}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
