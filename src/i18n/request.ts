import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { LOCALE_COOKIE, asLocale } from '@/lib/preferences';
import { mergeMessages } from '@/lib/merge-messages';

export default getRequestConfig(async () => {
  const locale = asLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const [vendored, own] = await Promise.all([
    import(`../../vendor/inflect-ui/messages/${locale}.json`),
    import(`../../messages/${locale}.json`),
  ]);
  return { locale, messages: mergeMessages(vendored.default, own.default) };
});
