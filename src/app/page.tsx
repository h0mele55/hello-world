import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card } from '@inflect/ui/components/ui/card';
import { Heading } from '@inflect/ui/components/ui/typography';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { buttonVariants } from '@inflect/ui/components/ui/button-variants';
import { PreferencesBar } from '@/components/preferences-bar';

export default async function HomePage() {
  const t = await getTranslations('app');
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-section px-default py-page">
      <PreferencesBar />
      <Card className="flex flex-col gap-default" data-surface="home-card">
        <Heading level={1}>{t('name')}</Heading>
        <p className="text-content-muted">{t('tagline')}</p>
        <StatusBadge variant="warning">{t('prototypeNotice')}</StatusBadge>
        <div className="flex flex-wrap gap-tight">
          <Link href="/reports" className={buttonVariants({ variant: 'primary' })} data-testid="sign-in-link">
            {t('signInLink')}
          </Link>
          <Link href="/kitchen-sink" className={buttonVariants({ variant: 'secondary' })}>
            {t('kitchenSinkLink')}
          </Link>
          <a
            href="https://github.com/h0mele55/hello-world/blob/master/docs/ROADMAP.md"
            className={buttonVariants({ variant: 'secondary' })}
          >
            {t('roadmapLink')}
          </a>
        </div>
      </Card>
    </main>
  );
}
