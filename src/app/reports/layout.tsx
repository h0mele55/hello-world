import Link from 'next/link';
import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { getIssuerKeyStatus, resolveAnchorTarget } from '@/lib/anchoring/queries';
import { requireUser } from '@/lib/page-auth';
import { PreferencesBar } from '@/components/preferences-bar';
import { SignOutButton } from '@/components/sign-out-button';

export const dynamic = 'force-dynamic';

export default async function ReportsLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const t = await getTranslations();
  const key = await getIssuerKeyStatus(resolveAnchorTarget().target);
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-section px-default py-page">
      <header className="flex flex-wrap items-center justify-between gap-default">
        <Link href="/reports" className="text-lg font-semibold text-content-emphasis">
          {t('app.name')}
        </Link>
        <div className="flex flex-wrap items-center gap-compact">
          <Link href="/reports/settings" className="text-content-muted hover:underline" data-testid="nav-settings">
            {t('nav.settings')}
          </Link>
          <span className="text-content-muted" data-testid="signed-in-as">
            {user.email}
          </span>
          <StatusBadge variant="neutral">{t(`nav.roles.${user.role}`)}</StatusBadge>
          <PreferencesBar />
          <SignOutButton />
        </div>
      </header>
      <StatusBadge variant="warning">{t('app.prototypeNotice')}</StatusBadge>
      {key?.low ? (
        <p role="alert" className="text-content-error" data-testid="low-balance">
          {t('nav.lowBalance')}
        </p>
      ) : null}
      {children}
    </div>
  );
}
