/**
 * Public-track helpers: encode/decode `AgentCompliance` payloads and read attestations from the
 * EAS predeploy. Verification here is fully transparent — the relying party learns who attested,
 * under which accreditation, until when. For the pseudonymous track see `proof.ts`.
 */
import {
  type Address,
  decodeAbiParameters,
  encodeAbiParameters,
  type Hex,
  parseAbiParameters,
  type PublicClient,
  zeroHash,
} from "viem";

import { EAS_PREDEPLOY, easAbi, FRAMEWORK_VERSION, type RiskTier } from "./constants.js";

/** Field layout of AGENT_COMPLIANCE_SCHEMA (EAS encodes schema fields as a flat ABI tuple). */
const COMPLIANCE_PARAMS = parseAbiParameters(
  "uint256 agentId, address deployer, string frameworkVersion, uint8 dimensionsBitmap, uint8 riskTier, bytes32 agentVersionHash, bytes32 evidenceHash, uint256 identityCommitment",
);

export interface AgentComplianceFields {
  /** ERC-8004 IdentityRegistry token id (0n if the agent is not registered there). */
  agentId: bigint;
  /** Address representing the accountable legal entity operating the agent. */
  deployer: Address;
  /** Framework version pin; defaults to FRAMEWORK_VERSION. */
  frameworkVersion?: string;
  /** MgfDimension bit flags assessed as aligned. */
  dimensionsBitmap: number;
  riskTier: RiskTier;
  /** Hash of the assessed deployment configuration (models, scaffold, tool allowlist, prompts). */
  agentVersionHash: Hex;
  /** Commitment to the content-addressed evidence-bundle manifest. */
  evidenceHash: Hex;
  /** The agent's Semaphore identity commitment (the private-track membership leaf). */
  identityCommitment: bigint;
}

/** Encodes the schema payload exactly as the on-chain resolver decodes it. */
export function encodeComplianceData(fields: AgentComplianceFields): Hex {
  return encodeAbiParameters(COMPLIANCE_PARAMS, [
    fields.agentId,
    fields.deployer,
    fields.frameworkVersion ?? FRAMEWORK_VERSION,
    fields.dimensionsBitmap,
    fields.riskTier,
    fields.agentVersionHash,
    fields.evidenceHash,
    fields.identityCommitment,
  ]);
}

export function decodeComplianceData(data: Hex): Required<AgentComplianceFields> {
  const [agentId, deployer, frameworkVersion, dimensionsBitmap, riskTier, agentVersionHash, evidenceHash, identityCommitment] =
    decodeAbiParameters(COMPLIANCE_PARAMS, data);
  return {
    agentId,
    deployer,
    frameworkVersion,
    dimensionsBitmap,
    riskTier: riskTier as RiskTier,
    agentVersionHash,
    evidenceHash,
    identityCommitment,
  };
}

export interface OnchainAttestation {
  uid: Hex;
  schema: Hex;
  time: bigint;
  expirationTime: bigint;
  revocationTime: bigint;
  refUID: Hex;
  recipient: Address;
  attester: Address;
  revocable: boolean;
  data: Hex;
}

/** Reads a raw attestation from the EAS predeploy (any OP Stack chain). */
export async function fetchAttestation(
  client: PublicClient,
  uid: Hex,
  eas: Address = EAS_PREDEPLOY,
): Promise<OnchainAttestation> {
  const attestation = await client.readContract({
    address: eas,
    abi: easAbi,
    functionName: "getAttestation",
    args: [uid],
  });
  return attestation as OnchainAttestation;
}

export type PublicCheckResult =
  | { valid: true; attestation: OnchainAttestation; fields: Required<AgentComplianceFields> }
  | { valid: false; reason: "not-found" | "revoked" | "expired"; attestation?: OnchainAttestation };

/**
 * Full public-track check: the attestation exists, is unrevoked, and is unexpired
 * (judged against the chain's latest block timestamp, not local clock).
 * Note that who attested — and whether that attester is still accredited — is itself on-chain:
 * relying parties with stricter needs should also consult the AccreditationRegistry.
 */
export async function checkCompliancePublic(
  client: PublicClient,
  uid: Hex,
  eas: Address = EAS_PREDEPLOY,
): Promise<PublicCheckResult> {
  const attestation = await fetchAttestation(client, uid, eas);
  if (attestation.uid === zeroHash) {
    return { valid: false, reason: "not-found" };
  }
  if (attestation.revocationTime !== 0n) {
    return { valid: false, reason: "revoked", attestation };
  }
  const { timestamp } = await client.getBlock();
  if (attestation.expirationTime !== 0n && attestation.expirationTime <= timestamp) {
    return { valid: false, reason: "expired", attestation };
  }
  return { valid: true, attestation, fields: decodeComplianceData(attestation.data) };
}

/**
 * TODO (phase 1): verifier-side issuance flow. The intended shape is an EIP-712 delegated
 * attestation — the accredited verifier signs the attestation offline (keys stay cold) and any
 * account submits it, paying gas; `@ethereum-attestation-service/eas-sdk` provides
 * `getDelegated()` / `attestByDelegation` for exactly this. Requires a wallet + RPC, so it is
 * out of scope for the offline PoC demo.
 */
export async function requestAttestation(): Promise<never> {
  throw new Error(
    "requestAttestation is not implemented in the PoC. See the TODO in sdk/src/attestation.ts (delegated attestation via eas-sdk).",
  );
}
