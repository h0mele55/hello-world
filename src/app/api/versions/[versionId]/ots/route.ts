import { handler } from '@/lib/http';
import { readOtsProof } from '@/lib/ots/queries';

/** The version's OpenTimestamps proof (#66), a detached .ots file of its manifest hash. */
export const GET = handler<{ params: Promise<{ versionId: string }> }>(async (_req, user, ctx) => {
  const { bytes, version } = await readOtsProof(user, (await ctx.params).versionId);
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="report-v${version}-manifest.ots"`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
