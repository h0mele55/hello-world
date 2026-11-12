import { getAddress, isAddress } from 'viem';
import { z } from 'zod';
import { NORMALISER_VERSION } from './opinion/normalise';
import { OPINION_TYPES } from './opinion/types';

/**
 * What a distribution copy says about its own anchor, in its XMP metadata and,
 * mirrored, in its document Info dictionary. Isomorphic (no Node imports), so
 * the Phase 4 browser verifier reads stamps with this same code.
 *
 * A stamp is a claim, not proof: a reader learns which record a file names,
 * and only the chain can say whether that record is this file.
 */

/**
 * The version written now. Version 2 (#157) adds `opinionEdited`: 1 when the
 * preparer corrected, at confirmation, the opinion the locator found, so the
 * committed opinion is not the file's own passage and no re-render can be
 * checked against it. Version 1 stamps are still read; they say nothing
 * about it.
 */
export const STAMP_VERSION = 2;
export const STAMP_NAMESPACE = 'https://github.com/h0mele55/hello-world/ns/audit-anchor/1.0/';
export const STAMP_PREFIX = 'auditanchor';
/** Info dictionary keys are the field names in PascalCase after this prefix. */
export const INFO_KEY_PREFIX = 'AuditAnchor';

const bytes32 = z.string().regex(/^0x[0-9a-f]{64}$/, 'a lower-case 0x-prefixed 32-byte hex string');
const positiveInt = z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

const commonFields = {
  chainId: positiveInt,
  contract: z.string().refine((value) => isAddress(value, { strict: false }) && getAddress(value) === value, 'a checksummed address'),
  recordId: bytes32,
  txHash: bytes32,
  blockNumber: positiveInt,
  familyId: bytes32,
  version: positiveInt.pipe(z.number().max(0xffffffff)),
  // Printable ASCII without the characters PDF strings and XML must escape.
  verifyUrl: z
    .string()
    .max(200)
    .regex(/^https?:\/\/[\x21-\x7e]+$/, 'an http(s) URL')
    .refine((value) => !/[()\\<>&"']/.test(value), 'no ( ) \\ < > & " or \''),
  opinionType: z.enum(OPINION_TYPES),
  opinionSalt: bytes32,
  norm: z.coerce.number().pipe(z.literal(NORMALISER_VERSION)),
};

export const StampFieldsV1Schema = z.strictObject({ stamp: z.coerce.number().pipe(z.literal(1)), ...commonFields });
export const StampFieldsV2Schema = z.strictObject({
  stamp: z.coerce.number().pipe(z.literal(2)),
  ...commonFields,
  opinionEdited: z.coerce.number().pipe(z.union([z.literal(0), z.literal(1)])),
});
/** Either version, as read; the worker writes STAMP_VERSION. */
export const StampFieldsSchema = z.union([StampFieldsV2Schema, StampFieldsV1Schema]);

export type StampFields = z.infer<typeof StampFieldsSchema>;
export type StampFieldName = keyof z.infer<typeof StampFieldsV2Schema>;

const V1_FIELD_NAMES = Object.keys(StampFieldsV1Schema.shape) as StampFieldName[];
/** Every field any version has, in the order they are written. */
export const STAMP_FIELD_NAMES = Object.keys(StampFieldsV2Schema.shape) as StampFieldName[];
/** The fields a stamp of this version has. */
export const fieldNamesOf = (fields: StampFields): StampFieldName[] => (fields.stamp === 1 ? V1_FIELD_NAMES : STAMP_FIELD_NAMES);
/** One field's value, or undefined when this version has none. */
export const fieldOf = (fields: StampFields, name: StampFieldName): unknown => (fields as Record<string, unknown>)[name];

export const infoKeyOf = (field: StampFieldName) => `${INFO_KEY_PREFIX}${field[0].toUpperCase()}${field.slice(1)}`;

export function stampValues(fields: StampFields): [StampFieldName, string][] {
  const valid = StampFieldsSchema.parse(fields);
  return fieldNamesOf(valid).map((name) => [name, String(fieldOf(valid, name))]);
}

export type StampReading =
  | { status: 'NONE' }
  | { status: 'MALFORMED'; reason: 'XMP_INVALID' | 'INFO_INVALID' | 'XMP_INFO_DISAGREE' }
  | { status: 'FOUND'; fields: StampFields; inXmp: boolean; inInfo: boolean };

const unescapeXml = (value: string) =>
  value.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[name]!);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Reads the stamp fields from an XMP packet, under whatever prefix the packet
 * binds to the namespace, as elements or as attributes. Null when the
 * namespace is absent.
 *
 * Only inside the rdf:Description that binds the namespace (#144): an
 * original's own XMP may bind the same prefix to something else, and its
 * elements come first.
 */
function readXmp(xmp: string | null): Record<string, string> | null {
  if (!xmp || !xmp.includes(STAMP_NAMESPACE)) return null;
  const ns = escapeRegExp(STAMP_NAMESPACE);
  const opening = new RegExp(`<rdf:Description\\b[^>]*?\\sxmlns:([A-Za-z_][\\w.-]*)=["']${ns}["'][^>]*>`).exec(xmp);
  let prefixName: string;
  let scope: string;
  if (opening) {
    prefixName = opening[1];
    const selfClosing = opening[0].endsWith('/>');
    const end = selfClosing ? -1 : xmp.indexOf('</rdf:Description>', opening.index);
    scope = selfClosing || end < 0 ? opening[0] : xmp.slice(opening.index, end);
  } else {
    // Bound somewhere other than a description (another writer's layout): the packet is the scope.
    const binding = new RegExp(`xmlns:([A-Za-z_][\\w.-]*)=["']${ns}["']`).exec(xmp);
    if (!binding) return {};
    prefixName = binding[1];
    scope = xmp;
  }
  const prefix = escapeRegExp(prefixName);
  const found: Record<string, string> = {};
  for (const name of STAMP_FIELD_NAMES) {
    const element = new RegExp(`<${prefix}:${name}>([^<]*)</${prefix}:${name}>`).exec(scope);
    const attribute = new RegExp(`\\s${prefix}:${name}=["']([^"'<]*)["']`).exec(scope);
    const value = element?.[1] ?? attribute?.[1];
    if (value !== undefined) found[name] = unescapeXml(value.trim());
  }
  return found;
}

/** Reads the mirrored Info keys, as the parser reports them (`Custom:AuditAnchor…`). */
function readInfo(info: Record<string, string>): Record<string, string> | null {
  const found: Record<string, string> = {};
  for (const name of STAMP_FIELD_NAMES) {
    const value = info[`Custom:${infoKeyOf(name)}`] ?? info[infoKeyOf(name)];
    if (value !== undefined) found[name] = value.trim();
  }
  return Object.keys(found).length > 0 ? found : null;
}

export function readStamp(xmp: string | null, info: Record<string, string>): StampReading {
  const fromXmp = readXmp(xmp);
  const fromInfo = readInfo(info);
  if (!fromXmp && !fromInfo) return { status: 'NONE' };
  const parsedXmp = fromXmp ? StampFieldsSchema.safeParse(fromXmp) : null;
  const parsedInfo = fromInfo ? StampFieldsSchema.safeParse(fromInfo) : null;
  if (parsedXmp && !parsedXmp.success) return { status: 'MALFORMED', reason: 'XMP_INVALID' };
  if (parsedInfo && !parsedInfo.success) return { status: 'MALFORMED', reason: 'INFO_INVALID' };
  const xmpFields = parsedXmp?.data;
  const infoFields = parsedInfo?.data;
  if (xmpFields && infoFields && STAMP_FIELD_NAMES.some((name) => String(fieldOf(xmpFields, name)) !== String(fieldOf(infoFields, name)))) {
    return { status: 'MALFORMED', reason: 'XMP_INFO_DISAGREE' };
  }
  return { status: 'FOUND', fields: (xmpFields ?? infoFields)!, inXmp: !!xmpFields, inInfo: !!infoFields };
}
