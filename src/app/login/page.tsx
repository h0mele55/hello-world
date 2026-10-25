import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Card } from '@inflect/ui/components/ui/card';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { Heading } from '@inflect/ui/components/ui/typography';
import { currentUser } from '@/auth';
import { PreferencesBar } from '@/components/preferences-bar';
import { LoginForm } from '@/components/login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if (await currentUser()) redirect('/reports');
  const t = await getTranslations();
  return (
    <main className="mx-auto flex max-w-md flex-col gap-section px-default py-page">
      <PreferencesBar />
      <Card className="flex flex-col gap-default">
        <Heading level={1}>{t('login.title')}</Heading>
        <StatusBadge variant="warning">{t('app.prototypeNotice')}</StatusBadge>
        <LoginForm />
      </Card>
    </main>
  );
}
