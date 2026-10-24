import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import { TooltipProvider } from '@inflect/ui/components/ui/tooltip';
import { AppToaster } from '@/components/app-toaster';
import { ThemeProvider } from '@/components/theme-provider';
import { THEME_COOKIE, asTheme } from '@/lib/preferences';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app');
  return { title: t('name'), description: t('tagline') };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const theme = asTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang={locale} data-theme={theme}>
      <body>
        <NextIntlClientProvider>
          <ThemeProvider initialTheme={theme}>
            <TooltipProvider>
              {children}
              <AppToaster />
            </TooltipProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
