// Reads a PDF's Info dictionary and XMP packet from pdf.js's getMetadata(),
// the same way on the server and in the browser. Plain JavaScript.

function stringsOf(dict) {
  const out = {};
  if (!dict || typeof dict !== 'object') return out;
  // pdf.js 6 hands custom Info keys over as a Map, the standard ones as an object.
  for (const [key, value] of dict instanceof Map ? dict.entries() : Object.entries(dict)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** The Info dictionary's string values; custom keys are prefixed `Custom:`. */
export function infoOf(info) {
  const custom = stringsOf(info?.Custom);
  return { ...stringsOf(info), ...Object.fromEntries(Object.entries(custom).map(([k, v]) => [`Custom:${k}`, v])) };
}

/** The raw XMP packet, or null when absent or longer than `maxChars`. */
export function xmpOf(metadata, maxChars) {
  const xmp = metadata && typeof metadata.getRaw === 'function' ? metadata.getRaw() : null;
  return typeof xmp === 'string' && xmp.length <= maxChars ? xmp : null;
}
