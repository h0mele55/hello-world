/**
 * PoCA offline demo — the private track end-to-end, no chain required.
 *
 * What happens on-chain in the real system is simulated locally:
 *   - "attestation issued"  → identity commitment inserted into the tier group
 *   - "attestation revoked" → member removed (what finalizeRemoval does on-chain)
 *
 * The ZK parts are real: a Groth16 proof is generated with the locally installed
 * @zk-kit/semaphore-artifacts (no network) and verified with Semaphore's bundled
 * verification keys.
 *
 * Run: npm run demo
 */
import { existsSync } from "node:fs";

import { Group } from "@semaphore-protocol/group";
import { keccak256, stringToBytes } from "viem";

import { encodeComplianceData, decodeComplianceData } from "../src/attestation.js";
import { ALL_DIMENSIONS, FRAMEWORK_VERSION } from "../src/constants.js";
import { createAgentIdentity } from "../src/identity.js";
import { generateComplianceProof, localArtifactPaths, verifyComplianceProofOffchain } from "../src/proof.js";

function scopeFor(service: string): bigint {
  // The relying party defines the scope (external nullifier): service + action (+ epoch).
  return BigInt(keccak256(stringToBytes(service)));
}

async function main() {
  console.log("PoCA offline demo — proof of compliant agenthood, private track\n");

  // 0. Proving artifacts (vendored via npm; depth-2 pair covers a 3-member set).
  const artifacts = localArtifactPaths(2);
  if (!existsSync(artifacts.wasm) || !existsSync(artifacts.zkey)) {
    console.log("SKIPPED: @zk-kit/semaphore-artifacts is not installed (dev dependency, ~170 MB).");
    console.log("Run `npm install` in sdk/ and try again.");
    return;
  }

  // 1. Three attested agents (in production: three AgentCompliance attestations, each carrying
  //    an identityCommitment that ComplianceSetManager inserted into the tier-2 group).
  const alpha = createAgentIdentity("agent-alpha-secret");
  const beta = createAgentIdentity("agent-beta-secret");
  const gamma = createAgentIdentity("agent-gamma-secret");

  const payload = encodeComplianceData({
    agentId: 1n,
    deployer: "0x00000000000000000000000000000000000a11ce",
    dimensionsBitmap: ALL_DIMENSIONS,
    riskTier: 2,
    agentVersionHash: keccak256(stringToBytes("model+scaffold+tools config v1")),
    evidenceHash: keccak256(stringToBytes("evidence-bundle manifest root")),
    identityCommitment: alpha.commitment,
  });
  const decoded = decodeComplianceData(payload);
  console.log("1. Sample AgentCompliance payload (encode → decode roundtrip):");
  console.log(`   frameworkVersion = ${decoded.frameworkVersion} (pin: ${FRAMEWORK_VERSION})`);
  console.log(`   riskTier         = ${decoded.riskTier}, dimensionsBitmap = 0b${decoded.dimensionsBitmap.toString(2).padStart(4, "0")}`);
  console.log(`   identityCommitment = ${decoded.identityCommitment.toString().slice(0, 24)}…\n`);

  // 2. The tier-2 compliance set, rebuilt from the public member list.
  const tier2 = new Group([alpha.commitment, beta.commitment, gamma.commitment]);
  console.log("2. Tier-2 compliance set: 3 members, depth", tier2.depth, "\n   root =", tier2.root.toString(), "\n");

  // 3. A relying party challenges agent alpha.
  const scope = scopeFor("api.example.com/orders#tier-2-access#epoch-2026-09-21");
  const challenge = 1234567890n; // fresh nonce from the relying party
  console.log("3. Agent alpha proves tier-2 compliance (real Groth16 proof, local artifacts)...");
  let startedAt = Date.now();
  const proof = await generateComplianceProof(alpha, tier2, challenge, scope);
  console.log(`   generated in ${Date.now() - startedAt} ms`);
  console.log(`   valid (off-chain verify): ${await verifyComplianceProofOffchain(proof)}`);
  console.log(`   nullifier = ${proof.nullifier.slice(0, 24)}…`);
  console.log("   The relying party learns: SOME tier-2-attested agent — not which one.\n");

  // 4. Nullifier semantics: rate-limiting without identity.
  const proofSameScope = await generateComplianceProof(alpha, tier2, 999n, scope);
  const proofOtherScope = await generateComplianceProof(alpha, tier2, challenge, scopeFor("other.service/#action"));
  console.log("4. Nullifier semantics:");
  console.log(`   same agent, same scope   → same nullifier?      ${proofSameScope.nullifier === proof.nullifier}`);
  console.log(`   same agent, other scope  → different nullifier? ${proofOtherScope.nullifier !== proof.nullifier}`);
  console.log("   → a relying party stores (scope, nullifier) pairs to stop reuse; services cannot link an agent across scopes.\n");

  // 5. Revocation: beta's attestation is revoked → keeper finalizes removal on-chain.
  const rootBeforeRevocation = tier2.root;
  tier2.removeMember(tier2.indexOf(beta.commitment));
  console.log("5. Beta's attestation is revoked (simulating EAS revoke → finalizeRemoval):");
  console.log(`   root changed: ${rootBeforeRevocation !== tier2.root}`);
  console.log("   Proofs carrying the old root die once Semaphore's root-history window (1h) lapses.");
  try {
    await generateComplianceProof(beta, tier2, challenge, scope);
    console.log("   ERROR: revoked agent could still prove — this should not happen");
    process.exitCode = 1;
  } catch {
    console.log("   beta can no longer generate a membership proof ✓");
  }
  const alphaAfter = await generateComplianceProof(alpha, tier2, 4321n, scope);
  console.log(`   alpha still proves against the new root: ${await verifyComplianceProofOffchain(alphaAfter)}\n`);

  console.log("Done. On-chain, step 3's proof is checked by ComplianceRouter.verifyCompliance(tier, proof)");
  console.log("(view call; see contracts/src/ComplianceRouter.sol), and the public track is one");
  console.log("checkCompliancePublic(client, uid) call against the EAS predeploy.");
}

/** snarkjs keeps its bn128 worker threads alive after proving; release them so Node can exit. */
async function terminateCurveWorkers(): Promise<void> {
  const curve = (globalThis as Record<string, unknown>).curve_bn128 as { terminate?: () => Promise<void> } | undefined;
  await curve?.terminate?.();
}

main()
  .then(async () => {
    await terminateCurveWorkers();
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (error) => {
    console.error("demo failed:", error);
    await terminateCurveWorkers();
    process.exit(1);
  });
