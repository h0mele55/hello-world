import { getTranslations } from 'next-intl/server';
import { KitchenSink } from './kitchen-sink';

export async function generateMetadata() {
  const t = await getTranslations('kitchenSink');
  return { title: t('title') };
}

export default function KitchenSinkPage() {
  return <KitchenSink />;
}
