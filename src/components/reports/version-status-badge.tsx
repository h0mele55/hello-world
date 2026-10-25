import { useTranslations } from 'next-intl';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import type { VersionStatus } from '@/generated/prisma/enums';

const VARIANT = { DRAFT: 'warning', CONFIRMED: 'info', APPROVED: 'info', ANCHORED: 'success', COMPLETE: 'success', REVOKED: 'error' } as const satisfies Record<VersionStatus, string>;

export function VersionStatusBadge({ status }: { status: VersionStatus }) {
  const t = useTranslations('reports.status');
  return <StatusBadge variant={VARIANT[status]}>{t(status)}</StatusBadge>;
}
