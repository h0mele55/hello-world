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

export const STAMP_VERSION = 1;
export const STAMP_NAMESPACE = 'https://github.com/h0mele55/hello-world/ns/audit-anchor/1.0/';
export const STAMP_PREFIX = 'auditanchor';
/** Info dictionary keys are the field names in PascalCase after this prefix. */
export const INFO_KEY_PREFIX = 'AuditAnchor';

const bytes32 = z.string().regex(/^0x[0-9a-f]{64}$/, 'a lower-case 0x-prefixed 32-byte hex string');
const positiveInt = z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const StampFieldsSchema = z.strictObject({
  stamp: z.coerce.number().pipe(z.literal(STAMP_VERSION)),
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
});

export type StampFields = z.infer<typeof StampFieldsSchema>;

/** The order fields are written in. */
export const STAMP_FIELD_NAMES = Object.keys(StampFieldsSchema.shape) as (keyof StampFields)[];

export const infoKeyOf = (field: keyof StampFields) => `${INFO_KEY_PREFIX}${field[0].toUpperCase()}${field.slice(1)}`;

export function stampValues(fields: StampFields): [keyof StampFields, string][] {
  const valid = StampFieldsSchema.parse(fields);
  return STAMP_FIELD_NAMES.map((name) => [name, String(valid[name])]);
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
 */
function readXmp(xmp: string | null): Record<string, string> | null {
  if (!xmp || !xmp.includes(STAMP_NAMESPACE)) return null;
  const binding = new RegExp(`xmlns:([A-Za-z_][\\w.-]*)=["']${escapeRegExp(STAMP_NAMESPACE)}["']`).exec(xmp);
  if (!binding) return {};
  const prefix = escapeRegExp(binding[1]);
  const found: Record<string, string> = {};
  for (const name of STAMP_FIELD_NAMES) {
    const element = new RegExp(`<${prefix}:${name}>([^<]*)</${prefix}:${name}>`).exec(xmp);
    const attribute = new RegExp(`\\s${prefix}:${name}=["']([^"'<]*)["']`).exec(xmp);
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
  if (xmpFields && infoFields && STAMP_FIELD_NAMES.some((name) => String(xmpFields[name]) !== String(infoFields[name]))) {
    return { status: 'MALFORMED', reason: 'XMP_INFO_DISAGREE' };
  }
  return { status: 'FOUND', fields: (xmpFields ?? infoFields)!, inXmp: !!xmpFields, inInfo: !!infoFields };
}
