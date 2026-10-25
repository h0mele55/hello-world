import { getTranslations } from 'next-intl/server';
import { Heading } from '@inflect/ui/components/ui/typography';
import { ClientsTable } from '@/components/console/clients-table';
import { CLIENT_LIST_CAP, listClients } from '@/lib/console/queries';
import { requireUser } from '@/lib/page-auth';

export default async function ClientsPage() {
  const user = await requireUser();
  const t = await getTranslations('console.clients');
  const { clients, truncated } = await listClients(user);
  return (
    <main className="flex flex-col gap-section">
      <Heading level={1}>{t('title')}</Heading>
      {truncated ? (
        <p role="status" className="text-content-warning" data-testid="clients-truncated">
          {t('truncated', { cap: CLIENT_LIST_CAP })}
        </p>
      ) : null}
      <ClientsTable clients={clients} />
    </main>
  );
}
