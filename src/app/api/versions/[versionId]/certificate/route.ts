import { readDistributable } from '@/lib/anchoring/downloads';
import { handler, pdfResponse } from '@/lib/http';

/** The verification certificate of an anchor-only version, once it is COMPLETE. */
export const GET = handler<{ params: Promise<{ versionId: string }> }>(async (_req, user, ctx) => {
  const { bytes, version } = await readDistributable(user, (await ctx.params).versionId, 'certificate');
  return pdfResponse(bytes, `report-v${version}-certificate.pdf`);
});
