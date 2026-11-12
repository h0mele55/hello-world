/**
 * Reading an answer from a server this code does not run, up to a cap (#147).
 * A declared length past the cap is refused before reading; otherwise the
 * body is read chunk by chunk and the read stops, cancelled, as soon as it
 * passes the cap, so an answer that never ends costs no more than the cap.
 * `res.text()` and `res.arrayBuffer()` read everything first and measure
 * after.
 *
 * No Node imports: the browser verifier shares it.
 */
export async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length'));
  if (declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
