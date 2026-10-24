'use client';

import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@inflect/ui/components/ui/button';
import { useTransition } from 'react';
import { setLocale } from '@/app/actions';
import { LOCALES, THEMES, type Locale } from '@/lib/preferences';
import { useTheme } from '@/components/theme-provider';

export function PreferencesBar() {
  const t = useTranslations('preferences');
  const router = useRouter();
  const locale = useLocale() as Locale;
  const { theme, setTheme } = useTheme();
  const [switchingLocale, startTransition] = useTransition();

  const chooseLocale = (next: Locale) =>
    startTransition(async () => {
      await setLocale(next);
      router.refresh();
    });

  return (
    <div className="flex flex-wrap items-center gap-compact" data-testid="preferences-bar">
      <div role="group" aria-label={t('theme')} className="flex items-center gap-tight">
        {THEMES.map((option) => (
          <Button
            key={option}
            type="button"
            size="sm"
            variant={theme === option ? 'primary' : 'secondary'}
            aria-pressed={theme === option}
            onClick={() => setTheme(option)}
            data-testid={`theme-${option}`}
          >
            {t(option)}
          </Button>
        ))}
      </div>
      <div role="group" aria-label={t('language')} className="flex items-center gap-tight">
        {LOCALES.map((option) => (
          <Button
            key={option}
            type="button"
            size="sm"
            variant={locale === option ? 'primary' : 'secondary'}
            aria-pressed={locale === option}
            disabled={switchingLocale}
            onClick={() => chooseLocale(option)}
            data-testid={`locale-${option}`}
          >
            {option.toUpperCase()}
          </Button>
        ))}
      </div>
    </div>
  );
}
