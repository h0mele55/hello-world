import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card } from '@inflect/ui/components/ui/card';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { Heading } from '@inflect/ui/components/ui/typography';
import { MfaSetup } from '@/components/account/mfa-setup';
import { PreferencesBar } from '@/components/preferences-bar';
import { SignOutButton } from '@/components/sign-out-button';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/page-auth';
import { MFA_ROLES } from '@/lib/roles';

export const dynamic = 'force-dynamic';

/**
 * Two-step sign-in for the caller's own account. An approver or admin without
 * a second factor lands here after signing in and can do nothing else until it
 * is set up (Phase 5, #52).
 */
export default async function MfaPage() {
  const user = await requireUser({ duringMfaEnrollment: true });
  const t = await getTranslations('account.mfa');
  const row = await db().user.findUnique({ where: { id: user.id }, select: { totpEnabledAt: true } });
  const required = MFA_ROLES.includes(user.role);
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-section px-default py-page">
      <div className="flex flex-wrap items-center justify-between gap-default">
        <PreferencesBar />
        <SignOutButton />
      </div>
      <Card className="flex flex-col gap-default" data-testid="mfa-page">
        <Heading level={1}>{t('title')}</Heading>
        {!required ? (
          <p className="text-content-muted" data-testid="mfa-not-needed">
            {t('notNeeded')}
          </p>
        ) : row?.totpEnabledAt ? (
          <div className="flex flex-col gap-tight" data-testid="mfa-on">
            <div>
              <StatusBadge variant="success">{t('on')}</StatusBadge>
            </div>
            {user.mfa === 'ENROLL' ? <p>{t('signInAgain')}</p> : <Link href="/reports" className="text-content-info hover:underline">{t('continue')}</Link>}
          </div>
        ) : (
          <>
            <p className="text-content-muted">{t('intro')}</p>
            <MfaSetup />
          </>
        )}
      </Card>
    </main>
  );
}
