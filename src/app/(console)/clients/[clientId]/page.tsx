import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Heading } from '@inflect/ui/components/ui/typography';
import { EngagementsTable } from '@/components/console/engagements-table';
import { getClient } from '@/lib/console/queries';
import { requireUser } from '@/lib/page-auth';

export default async function ClientPage({ params }: { params: Promise<{ clientId: string }> }) {
  const user = await requireUser();
  const client = await getClient(user, (await params).clientId);
  if (!client) notFound();
  const t = await getTranslations('console.client');
  return (
    <main className="flex flex-col gap-section">
      <div className="flex flex-col gap-tight">
        <Link href="/clients" className="text-content-muted hover:underline">
          {t('back')}
        </Link>
        <Heading level={1}>{client.name}</Heading>
        <p className="text-content-muted" data-testid="client-summary">
          {t('summary', { registrationNumber: client.registrationNumber, country: client.country })}
        </p>
      </div>
      <Heading level={2}>{t('engagements')}</Heading>
      <EngagementsTable engagements={client.engagements} />
    </main>
  );
}
