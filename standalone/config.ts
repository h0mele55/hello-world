import { getAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';

/**
 * The settings a standalone verifier (the HTML file, the CLI) carries: the
 * registry, its runtime bytecode hash, two public RPC endpoints and the issuer
 * names. They are baked in at build time and, for the CLI, may be given on
 * the command line instead. Nothing here is a secret.
 */
export const StandaloneSetupSchema = z.object({
  chainId: z.number().int().positive(),
  registry: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => getAddress(value) as Address),
  runtimeBytecodeHash: z.string().regex(/^0x[0-9a-f]{64}$/).transform((value) => value as Hex),
  rpcUrls: z.tuple([z.string().url(), z.string().url()]),
  issuers: z.record(z.string(), z.string()),
  /** The issuer's public origin, whose /ots route gives a matched report's Bitcoin timestamp (#66); null for none. */
  appUrl: z.string().regex(/^https?:\/\/[^\s/]+$/).nullable().default(null),
  /** The roots a matched copy's electronic seal is checked against (#120), base64 DER; none for none. */
  sealRoots: z.array(z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/)).default([]),
});

export type StandaloneSetup = z.infer<typeof StandaloneSetupSchema>;

/** A deployment record (deployments/<network>.json) as the CLI reads one. */
const DeploymentFileSchema = z.object({
  chainId: z.number().int().positive(),
  address: z.string(),
  runtimeBytecodeHash: z.string(),
  issuer: z.object({ orgId: z.string(), orgName: z.string() }).optional(),
});

export function setupFromDeployment(json: unknown, rpcUrls: [string, string], appUrl: string | null = null, sealRoots: string[] = []): StandaloneSetup {
  const d = DeploymentFileSchema.parse(json);
  return StandaloneSetupSchema.parse({
    chainId: d.chainId,
    registry: d.address,
    runtimeBytecodeHash: d.runtimeBytecodeHash,
    rpcUrls,
    issuers: d.issuer ? { [d.issuer.orgId.toLowerCase()]: d.issuer.orgName } : {},
    appUrl,
    sealRoots,
  });
}

/** Base64 DER, as the setup carries the seal's roots, to bytes. */
export const rootsOf = (setup: StandaloneSetup) => setup.sealRoots.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

/** JSON with bigints as decimal strings: verdicts carry none today, but a future field must not crash the output. */
export const verdictJson = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
