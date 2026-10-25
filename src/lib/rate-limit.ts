/**
 * A sliding-window request limit, in memory per server process: enough for
 * the single-instance prototype. `take` records a request and says whether it
 * may proceed; a refused request is not recorded, so a client that keeps
 * hammering is let back in once its window has passed.
 */
export function createLimiter({ limit, windowMs }: { limit: number; windowMs: number }) {
  const seen = new Map<string, number[]>();
  return {
    take(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterSeconds: number } {
      const kept = (seen.get(key) ?? []).filter((t) => now - t < windowMs);
      if (kept.length >= limit) {
        seen.set(key, kept);
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((kept[0] + windowMs - now) / 1000)) };
      }
      kept.push(now);
      seen.set(key, kept);
      // Forget idle clients now and then, so the map cannot grow without bound.
      if (seen.size > 10_000) for (const [k, times] of seen) if (times.every((t) => now - t >= windowMs)) seen.delete(k);
      return { ok: true };
    },
  };
}

/**
 * The lookup page reads the chain on the server for every request, so it is
 * limited: 60 a minute per client address (#51), and 600 a minute in all,
 * which bounds the RPC traffic even when the address cannot be trusted.
 * The address comes from X-Forwarded-For only behind a proxy that overwrites
 * it (TRUST_PROXY_HEADERS=1), as for the login throttle.
 */
export const LOOKUP_PER_ADDRESS = 60;
export const LOOKUP_TOTAL = 600;
const perAddress = createLimiter({ limit: LOOKUP_PER_ADDRESS, windowMs: 60_000 });
const total = createLimiter({ limit: LOOKUP_TOTAL, windowMs: 60_000 });

export function takeLookup(address: string | null, now = Date.now()) {
  if (address) {
    const mine = perAddress.take(address, now);
    if (!mine.ok) return mine;
  }
  return total.take('*', now);
}

export function clientAddressOf(headers: Headers, env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  if (env.TRUST_PROXY_HEADERS !== '1') return null;
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
}
