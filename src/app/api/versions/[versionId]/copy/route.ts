import { readDistributable } from '@/lib/anchoring/downloads';
import { handler, pdfResponse } from '@/lib/http';

/** The anchored distribution copy, once the version is COMPLETE. */
export const GET = handler<{ params: Promise<{ versionId: string }> }>(async (_req, user, ctx) => {
  const { bytes, version } = await readDistributable(user, (await ctx.params).versionId, 'copy');
  return pdfResponse(bytes, `report-v${version}-anchored.pdf`);
});
