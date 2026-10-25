'use client';

import { Toaster } from 'sonner';
import { useTheme } from '@/components/theme-provider';

/** sonner's toast container, following the theme the user picks. */
export function AppToaster() {
  const { theme } = useTheme();
  return <Toaster theme={theme} position="bottom-right" />;
}
