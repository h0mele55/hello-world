import Link from 'next/link';
import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { getIssuerKeyStatus, resolveAnchorTarget } from '@/lib/anchoring/queries';
import { latestNightlyCheck } from '@/lib/console/audit-log';
import { requireUser } from '@/lib/page-auth';
import { MFA_ROLES } from '@/lib/roles';
import { PreferencesBar } from '@/components/preferences-bar';
import { SignOutButton } from '@/components/sign-out-button';
import { NavLink } from '@/components/console/nav-link';

export const dynamic = 'force-dynamic';

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const t = await getTranslations();
  const [key, nightly] = await Promise.all([getIssuerKeyStatus(resolveAnchorTarget().target), latestNightlyCheck(user)]);
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-section px-default py-page">
      <header className="flex flex-col gap-default">
        <div className="flex flex-wrap items-center justify-between gap-default">
          <Link href="/dashboard" className="text-lg font-semibold text-content-emphasis">
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
        </div>
        <nav aria-label={t('nav.label')} className="flex flex-wrap items-center gap-default border-b border-border-subtle pb-compact">
          <NavLink href="/dashboard" testId="nav-dashboard">
            {t('nav.dashboard')}
          </NavLink>
          <NavLink href="/clients" testId="nav-clients">
            {t('nav.clients')}
          </NavLink>
          <NavLink href="/reports" testId="nav-reports" except={['/reports/settings']}>
            {t('nav.reports')}
          </NavLink>
          <NavLink href="/audit-log" testId="nav-audit-log">
            {t('nav.auditLog')}
          </NavLink>
          <NavLink href="/reports/settings" testId="nav-settings">
            {t('nav.settings')}
          </NavLink>
          {MFA_ROLES.includes(user.role) ? (
            <NavLink href="/account/mfa" testId="nav-mfa">
              {t('nav.twoStep')}
            </NavLink>
          ) : null}
        </nav>
      </header>
      <StatusBadge variant="warning">{t('app.prototypeNotice')}</StatusBadge>
      {nightly.state === 'BROKEN' ? (
        <p role="alert" className="text-content-error" data-testid="audit-broken">
          {t('nav.auditBroken', { seq: nightly.seq })}{' '}
          <Link href="/audit-log" className="underline">
            {t('nav.auditLog')}
          </Link>
        </p>
      ) : null}
      {key?.low ? (
        <p role="alert" className="text-content-error" data-testid="low-balance">
          {t('nav.lowBalance')}
        </p>
      ) : null}
      {children}
    </div>
  );
}
