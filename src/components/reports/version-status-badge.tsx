import { useTranslations } from 'next-intl';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import type { VersionStatus } from '@/generated/prisma/enums';

const VARIANT = { DRAFT: 'warning', CONFIRMED: 'success' } as const satisfies Record<VersionStatus, string>;

export function VersionStatusBadge({ status }: { status: VersionStatus }) {
  const t = useTranslations('reports.status');
  return <StatusBadge variant={VARIANT[status]}>{t(status)}</StatusBadge>;
}
