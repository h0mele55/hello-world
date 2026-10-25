import Link from 'next/link';
import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { requireUser } from '@/lib/page-auth';
import { PreferencesBar } from '@/components/preferences-bar';
import { SignOutButton } from '@/components/sign-out-button';

export const dynamic = 'force-dynamic';

export default async function ReportsLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const t = await getTranslations();
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-section px-default py-page">
      <header className="flex flex-wrap items-center justify-between gap-default">
        <Link href="/reports" className="text-lg font-semibold text-content-emphasis">
          {t('app.name')}
        </Link>
        <div className="flex flex-wrap items-center gap-compact">
          <span className="text-content-muted" data-testid="signed-in-as">
            {user.email}
          </span>
          <StatusBadge variant="neutral">{t(`nav.roles.${user.role}`)}</StatusBadge>
          <PreferencesBar />
          <SignOutButton />
        </div>
      </header>
      <StatusBadge variant="warning">{t('app.prototypeNotice')}</StatusBadge>
      {children}
    </div>
  );
}
