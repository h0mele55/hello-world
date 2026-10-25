import { readDistributable } from '@/lib/anchoring/downloads';
import { handler } from '@/lib/http';

/** The anchored distribution copy, once the version is COMPLETE. */
export const GET = handler<{ params: Promise<{ versionId: string }> }>(async (_req, user, ctx) => {
  const { bytes, version } = await readDistributable(user, (await ctx.params).versionId, 'copy');
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="report-v${version}-anchored.pdf"`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
