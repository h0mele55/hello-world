/**
 * Private-track helpers: generate and verify Semaphore v4 membership proofs for a risk-tier
 * compliance set.
 *
 * Proving artifacts are resolved from the locally installed `@zk-kit/semaphore-artifacts`
 * package (one wasm/zkey pair per tree depth), so proof generation works fully offline —
 * deliberately: Semaphore's default artifact CDN may be unreachable in restricted environments,
 * and agents should not need one more network dependency to prove compliance.
 */
import { createRequire } from "node:module";
import path from "node:path";

import type { Group } from "@semaphore-protocol/group";
import type { Identity } from "@semaphore-protocol/identity";
import { generateProof, verifyProof } from "@semaphore-protocol/proof";
import type { Address, PublicClient } from "viem";

import { complianceRouterAbi, type RiskTier } from "./constants.js";

/**
 * The proof object produced by Semaphore v4 (derived from generateProof's return type; the
 * package's own type re-export does not resolve under NodeNext module resolution).
 */
export type SemaphoreProof = Awaited<ReturnType<typeof generateProof>>;

/** Local wasm/zkey pair for a given LeanIMT depth (1..32). */
export function localArtifactPaths(merkleTreeDepth: number): { wasm: string; zkey: string } {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve("@zk-kit/semaphore-artifacts/package.json");
  const artifactsDir = path.dirname(packageJson);
  return {
    wasm: path.join(artifactsDir, `semaphore-${merkleTreeDepth}.wasm`),
    zkey: path.join(artifactsDir, `semaphore-${merkleTreeDepth}.zkey`),
  };
}

/**
 * Generates a membership proof for a compliance set.
 *
 * @param identity The agent's Semaphore identity (must be a current member of `group`).
 * @param group The tier's compliance set, rebuilt from the public on-chain member list
 *              (MemberAdded/MemberRemoved events, or an indexer).
 * @param message The signal — bind it to the relying party's fresh challenge (nonce or request
 *                digest) so a captured proof cannot be replayed.
 * @param scope The external nullifier — the relying party defines it (service + action + epoch).
 *              One identity produces exactly one nullifier per scope.
 */
export async function generateComplianceProof(
  identity: Identity,
  group: Group,
  message: bigint | string,
  scope: bigint | string,
): Promise<SemaphoreProof> {
  const index = group.indexOf(identity.commitment);
  if (index === -1) {
    throw new Error(
      "identity is not a member of this compliance set (no live attestation inserted it, or it was removed)",
    );
  }
  const merkleProof = group.generateMerkleProof(index);
  const merkleTreeDepth = Math.max(1, merkleProof.siblings.length);
  return generateProof(identity, merkleProof, message, scope, merkleTreeDepth, localArtifactPaths(merkleTreeDepth));
}

/**
 * Verifies the zero-knowledge part of a proof off-chain (bundled verification keys, no network).
 * NOTE: this checks the proof against the root IT CARRIES. The binding of that root to the
 * current on-chain set — and nullifier bookkeeping — remain the relying party's job (use
 * `verifyOnRouter` plus a per-scope nullifier store; see ComplianceRouter's NatSpec).
 */
export async function verifyComplianceProofOffchain(proof: SemaphoreProof): Promise<boolean> {
  return verifyProof(proof);
}

/** Converts a JS SemaphoreProof into the uint256 tuple shape ComplianceRouter expects. */
export function toRouterProof(proof: SemaphoreProof): {
  merkleTreeDepth: bigint;
  merkleTreeRoot: bigint;
  nullifier: bigint;
  message: bigint;
  scope: bigint;
  points: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
} {
  const [p0, p1, p2, p3, p4, p5, p6, p7] = proof.points.map(BigInt);
  return {
    merkleTreeDepth: BigInt(proof.merkleTreeDepth),
    merkleTreeRoot: BigInt(proof.merkleTreeRoot),
    nullifier: BigInt(proof.nullifier),
    message: BigInt(proof.message),
    scope: BigInt(proof.scope),
    points: [p0, p1, p2, p3, p4, p5, p6, p7] as const,
  };
}

/**
 * On-chain verification against the live set: calls `ComplianceRouter.verifyCompliance` (view).
 * Semaphore accepts the group's current root or a recent historical one (≤ the group's
 * merkleTreeDuration). The caller still owns (scope, nullifier) replay bookkeeping.
 */
export async function verifyOnRouter(
  client: PublicClient,
  router: Address,
  riskTier: RiskTier,
  proof: SemaphoreProof,
): Promise<boolean> {
  return client.readContract({
    address: router,
    abi: complianceRouterAbi,
    functionName: "verifyCompliance",
    args: [riskTier, toRouterProof(proof)],
  });
}
