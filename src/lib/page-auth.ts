import 'server-only';
import { redirect } from 'next/navigation';
import { currentUser, type SessionUser } from '@/auth';
import { MFA_ROLES } from '@/lib/roles';

/**
 * The signed-in user, or a redirect to sign in. Every page calls this itself:
 * Next.js renders a layout and its page in parallel, so a check in the layout
 * alone does not stop the page from running.
 */
export async function requireUser(options: { duringMfaEnrollment?: boolean } = {}): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect('/login');
  // An approver or admin without a second factor sets one up before anything else.
  if (user.mfa === 'ENROLL' && MFA_ROLES.includes(user.role) && !options.duringMfaEnrollment) redirect('/account/mfa');
  return user;
}
