'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/** A console link that marks itself as the current page, for the eye and for screen readers. */
export function NavLink({ href, children, testId, except = [] }: { href: string; children: ReactNode; testId: string; except?: string[] }) {
  const pathname = usePathname();
  const within = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
  const current = within(href) && !except.some(within);
  return (
    <Link
      href={href}
      aria-current={current ? 'page' : undefined}
      className={current ? 'font-medium text-content-emphasis underline underline-offset-4' : 'text-content-muted hover:underline'}
      data-testid={testId}
    >
      {children}
    </Link>
  );
}
