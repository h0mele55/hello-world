/**
 * The mailer: sends the notices queued when a version supersedes an earlier
 * one (src/lib/notifications/mailer.ts). It holds no issuer key and talks to
 * no chain.
 *
 *   npm run mailer            # a pass every MAILER_INTERVAL_MS (default 30 s)
 *   npm run mailer -- --once  # one pass, then exit
 *
 *   DATABASE_URL     the app's database
 *   SMTP_URL         e.g. smtp://127.0.0.1:1025 (Mailpit in development), or
 *                    smtps://user:password@host:465; never logged
 *   MAIL_FROM        the sender, e.g. "Audit Report Anchoring <noreply@firm.example>"
 *   APP_PUBLIC_URL   the app's public origin, for the links
 */
import { PrismaPg } from '@prisma/adapter-pg';
import nodemailer from 'nodemailer';
import { PrismaClient } from '../src/generated/prisma/client';
import { deliverNotifications } from '../src/lib/notifications/mailer';

const refuse = (message: string): never => {
  console.error(JSON.stringify({ level: 'error', message: `mailer refused: ${message}` }));
  process.exit(2);
};
const env = (name: string) => process.env[name] || refuse(`${name} is not set`);

async function main() {
  const once = process.argv.includes('--once');
  const appUrl = env('APP_PUBLIC_URL');
  if (!/^https?:\/\/[^\s]+$/.test(appUrl)) refuse('APP_PUBLIC_URL must be an http(s) URL');
  const smtpUrl = env('SMTP_URL');
  if (!/^smtps?:\/\//.test(smtpUrl)) refuse('SMTP_URL must be an smtp:// or smtps:// URL');
  const from = env('MAIL_FROM');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env('DATABASE_URL') }) });
  // Plain text only, and nothing the message could pull in from a file or a URL.
  const smtp = nodemailer.createTransport(smtpUrl, { disableFileAccess: true, disableUrlAccess: true });
  const transport = { send: async (m: { to: string; subject: string; text: string }) => void (await smtp.sendMail({ from, to: m.to, subject: m.subject, text: m.text })) };

  let stopping = false;
  process.once('SIGTERM', () => (stopping = true));
  process.once('SIGINT', () => (stopping = true));
  const intervalMs = Number(process.env.MAILER_INTERVAL_MS || 30_000);
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000) refuse('MAILER_INTERVAL_MS must be a whole number of milliseconds, at least 1000');
  try {
    do {
      const report = await deliverNotifications({ prisma, transport, appUrl });
      console.log(JSON.stringify({ level: report.failed.length ? 'error' : 'info', message: 'mail pass', sent: report.sent.length, retrying: report.retrying.length, failed: report.failed, cancelled: report.cancelled.length }));
      if (!once && !stopping) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    } while (!once && !stopping);
  } finally {
    smtp.close();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ level: 'error', message: 'mailer stopped', error: error instanceof Error ? error.name : typeof error }));
  process.exit(2);
});
