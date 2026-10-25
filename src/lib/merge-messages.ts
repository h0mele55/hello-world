type Messages = { [key: string]: string | Messages };

/**
 * Deep-merges message trees. A key both trees define as a string is a
 * collision and throws: the vendored Inflect messages and this app's own must
 * never silently overwrite each other.
 */
export function mergeMessages(base: Messages, extra: Messages, trail: string[] = []): Messages {
  const out: Messages = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const existing = out[key];
    if (existing === undefined) {
      out[key] = value;
    } else if (typeof existing === 'object' && typeof value === 'object') {
      out[key] = mergeMessages(existing, value, [...trail, key]);
    } else {
      throw new Error(`Message key ${[...trail, key].join('.')} is defined twice`);
    }
  }
  return out;
}
