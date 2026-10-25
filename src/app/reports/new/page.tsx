import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Card } from '@inflect/ui/components/ui/card';
import { Heading } from '@inflect/ui/components/ui/typography';
import { requireUser } from '@/lib/page-auth';
import { NewEngagementForm } from '@/components/reports/new-engagement-form';

export default async function NewEngagementPage() {
  const user = await requireUser();
  if (user.role !== 'PREPARER') redirect('/reports');
  const t = await getTranslations('engagement');
  return (
    <main className="flex max-w-2xl flex-col gap-section">
      <Heading level={1}>{t('newTitle')}</Heading>
      <Card className="flex flex-col gap-default">
        <p className="text-content-muted">{t('newIntro')}</p>
        <NewEngagementForm />
      </Card>
    </main>
  );
}
