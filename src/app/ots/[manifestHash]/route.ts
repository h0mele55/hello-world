import { publicOtsProof } from '@/lib/ots/queries';

/**
 * A report's OpenTimestamps proof, by its manifest hash, for the verifier
 * (#66): public, like the hash itself, and readable from any origin, since
 * dist/verifier.html may be opened from anywhere. The proxy rate-limits it
 * with the lookup page. The proof only adds a time to a verdict; with this
 * server down the verifier still decides (rule 5).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ manifestHash: string }> }) {
  const proof = await publicOtsProof((await ctx.params).manifestHash.toLowerCase());
  const headers = { 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=60' };
  if (!proof) return new Response('No proof for this manifest.', { status: 404, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
  return new Response(proof, { headers: { ...headers, 'Content-Type': 'application/octet-stream' } });
}
