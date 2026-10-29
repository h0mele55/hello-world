import fs from 'node:fs/promises';
import { reanchorArchivesOf } from '@/lib/verify-setup';

/**
 * The n-th re-anchor archive or proof in REANCHOR_ARCHIVES (#126), for /verify:
 * records of a retired registry, which the page checks against their root on
 * this registry, in the browser, and fetches only for a file this registry
 * holds no record of. Public chain data, like the /ots route; nothing about
 * the file being checked is sent, and the proxy rate-limits it with the lookup
 * page. With this server down the page cannot load at all, and an archive it
 * cannot fetch leaves the verdict CANNOT_VERIFY, never NOT_REGISTERED.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ index: string }> }) {
  const { index } = await ctx.params;
  const files = reanchorArchivesOf();
  const n = /^(0|[1-9]\d{0,3})$/.test(index) ? Number(index) : -1;
  const headers = { 'X-Content-Type-Options': 'nosniff' };
  if (n < 0 || n >= files.length) return new Response('No such archive.', { status: 404, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
  try {
    return new Response(await fs.readFile(files[n]), { headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } });
  } catch {
    // The file's path is configuration, not something a visitor needs.
    return new Response('This archive cannot be read right now.', { status: 503, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' } });
  }
}
