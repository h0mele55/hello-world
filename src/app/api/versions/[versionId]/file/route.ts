import { handler, pdfResponse } from '@/lib/http';
import { readVersionFile } from '@/lib/reports/intake';

/** The decrypted PDF, for the confirmation screen's viewer. Never cached. */
export const GET = handler<{ params: Promise<{ versionId: string }> }>(async (_req, user, ctx) => {
  const bytes = await readVersionFile(user, (await ctx.params).versionId);
  return pdfResponse(bytes, 'report.pdf');
});
