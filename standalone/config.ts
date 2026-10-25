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
});

export type StandaloneSetup = z.infer<typeof StandaloneSetupSchema>;

/** A deployment record (deployments/<network>.json) as the CLI reads one. */
const DeploymentFileSchema = z.object({
  chainId: z.number().int().positive(),
  address: z.string(),
  runtimeBytecodeHash: z.string(),
  issuer: z.object({ orgId: z.string(), orgName: z.string() }).optional(),
});

export function setupFromDeployment(json: unknown, rpcUrls: [string, string]): StandaloneSetup {
  const d = DeploymentFileSchema.parse(json);
  return StandaloneSetupSchema.parse({
    chainId: d.chainId,
    registry: d.address,
    runtimeBytecodeHash: d.runtimeBytecodeHash,
    rpcUrls,
    issuers: d.issuer ? { [d.issuer.orgId.toLowerCase()]: d.issuer.orgName } : {},
  });
}

/** JSON with bigints as decimal strings: verdicts carry none today, but a future field must not crash the output. */
export const verdictJson = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
