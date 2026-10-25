import 'server-only';
import { redirect } from 'next/navigation';
import { currentUser, type SessionUser } from '@/auth';

/**
 * The signed-in user, or a redirect to sign in. Every page calls this itself:
 * Next.js renders a layout and its page in parallel, so a check in the layout
 * alone does not stop the page from running.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}
