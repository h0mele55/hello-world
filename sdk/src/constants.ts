/**
 * PoCA — Proof of Compliant Agenthood. Shared constants.
 *
 * The EAS contracts are genesis predeploys at the same addresses on every OP Stack chain
 * (OP Mainnet, OP Sepolia, Base, World Chain, ...), which is what makes the attestation
 * layer portable across the Superchain.
 */

export const SCHEMA_REGISTRY_PREDEPLOY = "0x4200000000000000000000000000000000000020" as const;
export const EAS_PREDEPLOY = "0x4200000000000000000000000000000000000021" as const;

/** ERC-8004 canonical Identity Registry (same vanity address on 16+ chains, incl. Optimism). */
export const ERC8004_IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;

export const OP_SEPOLIA_CHAIN_ID = 11155420;

/**
 * Version pin recorded in every attestation. An unversioned "compliant" claim is meaningless —
 * see docs/02-imda-alignment.md §6. This string names the framework edition the assessment
 * targeted; it implies no affiliation with or endorsement by IMDA.
 */
export const FRAMEWORK_VERSION = "IMDA-MGF-AgenticAI-v1.5";

/** Must stay byte-identical to the schema registered on-chain (see contracts/script/Deploy.s.sol). */
export const AGENT_COMPLIANCE_SCHEMA =
  "uint256 agentId,address deployer,string frameworkVersion,uint8 dimensionsBitmap,uint8 riskTier,bytes32 agentVersionHash,bytes32 evidenceHash,uint256 identityCommitment";

export const VERIFIER_ACCREDITATION_SCHEMA =
  "string accreditationScheme,bytes32 accreditationRef,string verifierName";

/**
 * Bit flags for the four dimensions of the IMDA Model AI Governance Framework for Agentic AI
 * (paraphrased; see docs/02-imda-alignment.md). Bit set = the accredited verifier assessed the
 * dimension as aligned at the attested tier.
 */
export enum MgfDimension {
  /** Dimension 1 — risks assessed and bounded upfront (action space, autonomy, reversibility). */
  BoundRisksUpfront = 1 << 0,
  /** Dimension 2 — humans meaningfully accountable (checkpoints, value-chain responsibility). */
  HumanAccountability = 1 << 1,
  /** Dimension 3 — technical controls and processes (identity, least privilege, testing, monitoring). */
  TechnicalControls = 1 << 2,
  /** Dimension 4 — end-user responsibility enabled (disclosure, escalation channel). */
  EndUserResponsibility = 1 << 3,
}

export const ALL_DIMENSIONS =
  MgfDimension.BoundRisksUpfront |
  MgfDimension.HumanAccountability |
  MgfDimension.TechnicalControls |
  MgfDimension.EndUserResponsibility;

/** Assessed autonomy × action-space envelope; selects the Semaphore group. */
export type RiskTier = 1 | 2 | 3;

/** Minimal ABI fragment for reading attestations from the EAS predeploy. */
export const easAbi = [
  {
    name: "getAttestation",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "uid", type: "bytes32" }],
    outputs: [
      {
        name: "attestation",
        type: "tuple",
        components: [
          { name: "uid", type: "bytes32" },
          { name: "schema", type: "bytes32" },
          { name: "time", type: "uint64" },
          { name: "expirationTime", type: "uint64" },
          { name: "revocationTime", type: "uint64" },
          { name: "refUID", type: "bytes32" },
          { name: "recipient", type: "address" },
          { name: "attester", type: "address" },
          { name: "revocable", type: "bool" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
  },
] as const;

/** ABI fragment of PoCA's ComplianceRouter (contracts/src/ComplianceRouter.sol). */
export const complianceRouterAbi = [
  {
    name: "verifyCompliance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "riskTier", type: "uint8" },
      {
        name: "proof",
        type: "tuple",
        components: [
          { name: "merkleTreeDepth", type: "uint256" },
          { name: "merkleTreeRoot", type: "uint256" },
          { name: "nullifier", type: "uint256" },
          { name: "message", type: "uint256" },
          { name: "scope", type: "uint256" },
          { name: "points", type: "uint256[8]" },
        ],
      },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "merkleTreeRoot",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "riskTier", type: "uint8" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "merkleTreeSize",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "riskTier", type: "uint8" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "groupIdOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "riskTier", type: "uint8" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
