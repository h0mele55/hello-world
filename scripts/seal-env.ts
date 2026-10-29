/**
 * The firm's electronic seal on distribution copies (#70), read from the
 * worker's environment only (never a file in the repository):
 *
 *   SEAL_PROVIDER       none (the default: copies are not sealed) or csc
 *   CSC_URL             the provider's CSC API v2 base URL, e.g. https://provider.example/csc/v2
 *   CSC_TOKEN_URL       optional; an OAuth 2.0 token endpoint (client credentials). Without it,
 *                       the API's own auth/login, with HTTP Basic
 *   CSC_CLIENT_ID       the worker's client at the provider
 *   CSC_CLIENT_SECRET   its secret. Read by this module only: the web app never holds it.
 *   CSC_CREDENTIAL_ID   the seal's credential
 *   CSC_PIN             optional; the credential's PIN, when the provider asks for one
 *   TSA_URL             the RFC 3161 timestamping authority
 *   TSA_USERNAME        optional, with TSA_PASSWORD: HTTP Basic at the authority
 *   TSA_PASSWORD
 *   TSA_POLICY          optional; the policy to ask the authority for (the token must name it)
 *   SEAL_TRUST_ANCHORS  a PEM file of the roots the seal certificate and the timestamping
 *                       authority must chain to: the provider's, as the firm accepts them
 *   SEAL_LEVEL          B-LT (the default): each copy also carries its certificates' status
 *                       at the seal's time, fetched from the responders they name (#119);
 *                       or B-T, the seal and its timestamp only
 *
 * With SEAL_PROVIDER=csc, a setting missing or malformed stops the worker at
 * start-up, before any copy is made: a copy is never made unsealed by accident.
 */
import fs from 'node:fs';
import path from 'node:path';
import { certificatesFromPem } from '../src/lib/verify-core/seal';
import type { CopySeal, SealLevel } from '../src/lib/eseal/copy';
import { cscSigner } from '../src/lib/eseal/csc';
import { rfc3161Timestamper } from '../src/lib/eseal/tsa';
import { refuse, requireEnv } from './issuer-env';

/** The seal, or undefined when the firm does not seal its copies. */
export function sealEnv(tool: string): CopySeal | undefined {
  const provider = process.env.SEAL_PROVIDER || 'none';
  if (provider === 'none') return undefined;
  if (provider !== 'csc') refuse(tool, 'SEAL_PROVIDER must be none or csc');
  const env = (name: string) => requireEnv(tool, name);
  const optional = (name: string) => process.env[name] || undefined;
  const level = (process.env.SEAL_LEVEL || 'B-LT') as SealLevel;
  if (level !== 'B-LT' && level !== 'B-T') refuse(tool, 'SEAL_LEVEL must be B-LT or B-T');
  try {
    return {
      signer: cscSigner({
        url: env('CSC_URL'),
        tokenUrl: optional('CSC_TOKEN_URL'),
        clientId: env('CSC_CLIENT_ID'),
        clientSecret: env('CSC_CLIENT_SECRET'),
        credentialId: env('CSC_CREDENTIAL_ID'),
        pin: optional('CSC_PIN'),
      }),
      timestamper: rfc3161Timestamper({ url: env('TSA_URL'), username: optional('TSA_USERNAME'), password: optional('TSA_PASSWORD'), policy: optional('TSA_POLICY') }),
      trustAnchors: readAnchors(tool, env('SEAL_TRUST_ANCHORS')),
      level,
    };
  } catch (error) {
    refuse(tool, error instanceof Error ? error.message : String(error));
  }
}

/** Every certificate in a PEM file, as DER; at least one, each one readable. */
export function readAnchors(tool: string, file: string): Uint8Array[] {
  let text: string;
  try {
    text = fs.readFileSync(path.resolve(file), 'utf8');
  } catch {
    refuse(tool, `SEAL_TRUST_ANCHORS (${file}) cannot be read`);
  }
  let roots: Uint8Array[];
  try {
    roots = certificatesFromPem(text);
  } catch {
    refuse(tool, `SEAL_TRUST_ANCHORS (${file}) holds a certificate that cannot be read`);
  }
  if (roots.length === 0) refuse(tool, `SEAL_TRUST_ANCHORS (${file}) holds no certificate`);
  return roots;
}
