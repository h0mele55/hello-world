# Architecture

> **Independence disclaimer.** PoCA is an independent open-source project, not affiliated with or endorsed by IMDA, the AI Verify Foundation, or the Government of Singapore. See [02-imda-alignment.md](02-imda-alignment.md).

## 1. On-chain topology

PoCA deploys four small contracts and leans on infrastructure that already exists on every OP Stack chain:

| Component | Address / origin | Role |
|---|---|---|
| `SchemaRegistry` | `0x4200000000000000000000000000000000000020` — **OP Stack genesis predeploy** ([spec](https://github.com/ethereum-optimism/specs/blob/main/specs/protocol/predeploys.md)) | Holds PoCA's two schema definitions |
| `EAS` | `0x4200000000000000000000000000000000000021` — OP Stack genesis predeploy | Stores attestations; enforces expiry/revocation; calls our resolver |
| [Semaphore v4](https://github.com/semaphore-protocol/semaphore) | Deployed per chain (reuse a canonical deployment where available) | Anonymity sets (one group per risk tier); ZK proof verification |
| [ERC-8004 IdentityRegistry](https://eips.ethereum.org/EIPS/eip-8004) | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (canonical, live on Optimism) | Public agent identity (`agentId` = ERC-721 token; registration file → A2A AgentCard, endpoints) |
| `AccreditationRegistry` | PoCA (this repo) | Who may attest, with expiry and revocation |
| `ComplianceResolver` | PoCA (this repo) | EAS schema resolver: gates attestations, drives set membership |
| `ComplianceSetManager` | PoCA (this repo) | Owns the Semaphore groups; insert on attest, two-phase removal on revoke |
| `ComplianceRouter` | PoCA (this repo) | Read-only verification façade for relying parties |

Because the EAS predeploys sit at the same addresses Superchain-wide, the whole design ports to Base, World Chain, or any OP Stack chain by redeploying only the four PoCA contracts and Semaphore.

## 2. EAS schemas

EAS-native fields (`attester`, `recipient`, `time`, `expirationTime`, `revocationTime`, `refUID`) are used directly and never duplicated inside schema payloads.

### `VerifierAccreditation` — foundation → verifier (transparency mirror)

```text
string accreditationScheme, bytes32 accreditationRef, string verifierName
```

| Field | Meaning |
|---|---|
| `accreditationScheme` | Human-readable scheme label, e.g. `"PoCA-Foundation-v1"`; may reference the real-world basis (e.g. an AI TAP accreditation) |
| `accreditationRef` | Hash/identifier of the verifier's underlying real-world credential document |
| `verifierName` | Display name of the verifying firm |

- `recipient` = verifier address; `expirationTime` ≈ 12 months (mirroring AI TAP's validity); `revocable` = true.
- **This attestation is a public record, not the enforcement point.** The authoritative gate is `AccreditationRegistry` (below); the registry entry stores this attestation's UID so indexers can join the two.

### `AgentCompliance` — verifier → agent (the core credential)

```text
uint256 agentId, address deployer, string frameworkVersion, uint8 dimensionsBitmap, uint8 riskTier, bytes32 agentVersionHash, bytes32 evidenceHash, uint256 identityCommitment
```

| Field | Meaning |
|---|---|
| `agentId` | The agent's [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) IdentityRegistry token id (0 if the agent opts out of ERC-8004) |
| `deployer` | Address representing the accountable legal entity operating the agent |
| `frameworkVersion` | Pinned framework identifier, e.g. `"IMDA-MGF-AgenticAI-v1.5"` |
| `dimensionsBitmap` | Bit *i* ⇒ dimension *i+1* assessed as aligned (see [mapping](02-imda-alignment.md#3-the-mapping-dimensions--attestation-schema--evidence)) |
| `riskTier` | 1–3: assessed autonomy × action-space envelope; selects the Semaphore group |
| `agentVersionHash` | Hash of the assessed deployment configuration (models, scaffold version, tool allowlist, prompts) |
| `evidenceHash` | Commitment to the content-addressed evidence-bundle manifest (AI Verify / Moonshot reports, process audit) |
| `identityCommitment` | The agent's Semaphore v4 identity commitment — the private track's membership leaf |

- `recipient` = agent's operational address (or deployer); `expirationTime` **required** (resolver rejects non-expiring attestations); `revocable` = true; `refUID` → the verifier's `VerifierAccreditation` UID or the agent's prior `AgentCompliance` UID (re-audit chain).
- Attestations may be **delegated** (EIP-712-signed by the verifier, submitted by anyone paying gas) using stock EAS mechanics.

## 3. Contracts

### `AccreditationRegistry`

Minimal, MIT, ours — deliberately *not* a fork of any copyleft role system (the pattern resembles ERC-3643's trusted-issuers registry and Hats-style revocable roles; the code is original).

- Storage: `mapping(address verifier => Accreditation {uint64 expiresAt; bool revoked; bytes32 accreditationUID; string metadataURI})`.
- `grantAccreditation(address verifier, uint64 expiresAt, bytes32 accreditationUID, string metadataURI)` — `onlyOwner` (the foundation; a multisig in any real deployment).
- `revokeAccreditation(address verifier)` — `onlyOwner`.
- `isAccredited(address verifier) → bool` — true iff granted, unrevoked, unexpired. Called by the resolver on every attestation.
- Events: `VerifierAccredited`, `VerifierRevoked`.

### `ComplianceResolver` (extends EAS [`SchemaResolver`](https://github.com/ethereum-attestation-service/eas-contracts))

Attached to the `AgentCompliance` schema at registration; EAS invokes it inside `attest`/`revoke`:

- `onAttest`: require `accreditationRegistry.isAccredited(attestation.attester)`; require `attestation.expirationTime != 0`; decode `(riskTier, identityCommitment)` from the payload; call `setManager.onAttested(uid, identityCommitment, riskTier)`. Any failure reverts the attestation — an unaccredited attestation can never exist on this schema.
- `onRevoke`: call `setManager.onRevoked(uid)`; always succeeds (revocation must never be blockable).
- The PoC intentionally performs **no on-chain ERC-8004 existence check** — the binding is verified off-chain by the verifier and surfaced by indexers; adding the check is a one-line resolver option listed in the roadmap.

### `ComplianceSetManager`

Owns the private track's state; only the resolver may mutate membership.

- `createTierGroup(uint8 tier)` — `onlyOwner`; creates a Semaphore group with this contract as admin; `groupIdOf[tier]`.
- `onAttested(bytes32 uid, uint256 identityCommitment, uint8 tier)` — `onlyResolver`; requires the tier group exists and the UID wasn't used before; `semaphore.addMember(groupId, identityCommitment)`; records `commitmentOf[uid]`.
- `onRevoked(bytes32 uid)` — `onlyResolver`; marks `removalPending[uid]` and emits `RemovalRequired(uid, tier, commitment)`.
- `finalizeRemoval(bytes32 uid, uint256[] siblings)` — **permissionless**, but only for attestation UIDs already marked `removalPending`; reads the tier and commitment from storage and calls `semaphore.removeMember(groupId, commitment, siblings)`. Removal state is keyed by **attestation UID, never by commitment alone**: the same Semaphore identity may legitimately back attestations in different tier groups, and a commitment-keyed flag would let a third party remove a membership whose attestation was never revoked.

**Why two-phase removal:** Semaphore v4's `removeMember` requires the LeanIMT sibling path of the leaf, which cannot be computed on-chain from inside an EAS revoke call. The resolver therefore *marks* the removal, and anyone (in practice, a keeper watching `RemovalRequired` — see roadmap) *finalizes* it with siblings computed off-chain from the public member list. The revocation-latency window this creates is analysed in [05-threat-model.md](05-threat-model.md).

### `ComplianceRouter`

The relying-party surface, mirroring `WorldIDRouter`'s role:

- `verifyCompliance(uint8 tier, SemaphoreProof proof) → bool` — **`view`**; wraps `semaphore.verifyProof(groupIdOf[tier], proof)`. Semaphore accepts the group's current Merkle root or a recent historical root within the group's configured duration (the root-history pattern World ID also uses).
- Deliberately **not** Semaphore's state-changing `validateProof`, which burns nullifiers globally per group — wrong for a multi-relying-party registry. Each relying party keeps its **own** nullifier store per scope (see [04-identity-and-privacy.md](04-identity-and-privacy.md)).
- Helpers: `groupIdOf(tier)`, `merkleTreeRoot(tier)`, `merkleTreeSize(tier)`.

## 4. Flows

### Attestation issuance (public track feeding the private track)

```mermaid
sequenceDiagram
    participant DEP as Deployer
    participant ACV as Accredited verifier
    participant EAS as EAS predeploy
    participant RES as ComplianceResolver
    participant REG as AccreditationRegistry
    participant MGR as ComplianceSetManager
    participant SEM as Semaphore

    DEP->>ACV: Engage; provide deployment + evidence access
    ACV->>ACV: Assess vs framework (AI Verify / Moonshot runs, process audit)
    ACV->>EAS: attest(AgentCompliance, expiry, refUID=accreditation)
    EAS->>RES: onAttest(attestation)
    RES->>REG: isAccredited(attester)?
    REG-->>RES: true
    RES->>MGR: onAttested(uid, identityCommitment, riskTier)
    MGR->>SEM: addMember(group[tier], identityCommitment)
    SEM-->>MGR: MemberAdded (root rotates)
    EAS-->>ACV: attestation UID
    ACV-->>DEP: UID + evidence manifest
```

### ZK verification (private track)

```mermaid
sequenceDiagram
    participant AG as Agent (SDK)
    participant IDX as Chain / indexer
    participant RP as Relying party
    participant RTR as ComplianceRouter
    participant SEM as Semaphore

    RP->>AG: Challenge: scope = hash(rp_id, action), message = nonce
    AG->>IDX: Fetch tier-group members
    AG->>AG: Rebuild LeanIMT; generateProof(identity, group, message, scope)
    AG->>RP: SemaphoreProof (incl. nullifier)
    RP->>RTR: verifyCompliance(tier, proof)  [view]
    RTR->>SEM: verifyProof(groupId, proof)
    SEM-->>RTR: valid (root current or within history window)
    RTR-->>RP: true
    RP->>RP: Check nullifier unseen for this scope; record it
    RP-->>AG: Access granted (learned tier, not identity)
```

Revocation and expiry flows are drawn in [04-identity-and-privacy.md](04-identity-and-privacy.md#5-revocation-and-expiry).

## 5. Deployment plan (OP Sepolia, chain id 11155420)

`script/Deploy.s.sol`:

1. Deploy `SemaphoreVerifier` + `Semaphore` (or reuse an existing deployment via `SEMAPHORE_ADDRESS`).
2. Deploy `AccreditationRegistry` (owner = deployer for the PoC; multisig for anything real).
3. Deploy `ComplianceSetManager(semaphore)`; create tier groups 1–3.
4. Deploy `ComplianceResolver(EAS@0x4200…21, registry, manager)`; wire `manager.setResolver(resolver)`.
5. Deploy `ComplianceRouter(semaphore, manager)`.
6. Register both schemas on `SchemaRegistry@0x4200…20` — `AgentCompliance` with the resolver attached, `revocable = true`.

The script runs as a dry simulation without an RPC; broadcasting requires only a funded key and `--rpc-url` for OP Sepolia. The same script works on any OP Stack chain because the predeploy addresses do not change.

## 6. Where this mirrors — and diverges from — World ID

| Design point | World ID | PoCA |
|---|---|---|
| Credential issuance | 3.0: operator inserts commitment on-chain; 4.0: issuers sign credentials off-chain against an issuer-schema registry | Verifier attests via EAS (on-chain record, off-chain evidence) — EAS *is* the issuer/schema registry the 4.0 design hand-rolls |
| Membership set | Global Merkle tree, bridged L1→L2, ~1h root expiry | Semaphore v4 groups native on the L2; root history per group; no bridging in the base design |
| Revocation | 3.0: none (`deleteIdentities` absent); 4.0: native | First-class from day one: EAS revoke → two-phase set removal; expiry sweeps in roadmap |
| Nullifiers | 3.0: Poseidon, linkable if secret leaks; 4.0: OPRF-hardened | Semaphore v4 Poseidon nullifiers per scope (OPRF upgrade tracked in roadmap) |
| Insertion permissioning | `onlyIdentityOperator` sequencer | Insertion is a *side effect of a gated attestation* — permissioned by accreditation, not by a sequencer role |

The World ID 3.0 → 4.0 shift (commitment-insertion → signed credentials with expiry and revocation) independently validates PoCA's EAS-centric shape; see the research notes in [06-open-source-landscape.md](06-open-source-landscape.md).
