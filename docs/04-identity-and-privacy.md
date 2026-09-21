# Identity layering and privacy design

> **Independence disclaimer.** PoCA is an independent open-source project, not affiliated with or endorsed by IMDA, the AI Verify Foundation, or the Government of Singapore. See [02-imda-alignment.md](02-imda-alignment.md).

## 1. Three identity layers, one binding

| Layer | What it is | Who sees it |
|---|---|---|
| **Public agent identity** | [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) `agentId` (ERC-721) + registration file → A2A AgentCard, MCP/service endpoints, operational addresses | Everyone — this is the discoverable "who" |
| **Accountable entity** | `deployer` address in the attestation, representing the legal entity answerable for the agent (framework dimension 2) | Everyone |
| **Anonymity-set identity** | Semaphore v4 identity (EdDSA keypair held by the agent); its **commitment** is the leaf inserted into the tier group | Commitment: everyone. Which proof came from which commitment: no one |

The `AgentCompliance` attestation binds all three **publicly and deliberately**: `agentId`, `deployer`, and `identityCommitment` sit in the same attestation. PoCA is an accountability system first — the private track exists to protect agents' *operational* privacy from counterparties, not to hide who is attested from the world.

**The precise privacy statement:** the set of attested commitments is public (as in World ID, where all identity commitments are on-chain). What a Semaphore proof hides is *which member* generated it. A relying party that verifies a proof learns: (a) some member of the tier-T set produced it, (b) bound to my scope, (c) with nullifier N. It cannot map N back to an `agentId`. Different scopes yield unlinkable nullifiers, so two services cannot correlate the same agent across themselves via the proof layer alone.

What the private track does **not** hide: timing/network metadata, anything the agent reveals in-band, and membership churn (an insertion following an attestation is publicly visible — in tiny groups, timing correlation can deanonymize; anonymity grows with the set, which is also true of World ID).

## 2. Why a group per risk tier

The proof's semantic payload is exactly "membership of group G". Relying parties need assurance levels, so G must encode the tier: three groups (tier 1–3) rather than one global set. A single global group would force tier disclosure through side channels or make the proof semantically weak; per-tier groups keep the statement clean at the cost of splitting the anonymity set — an accepted trade-off, again matching World ID's separate groups (e.g. Orb vs device credentials).

## 3. Scopes, nullifiers, and replay

Semaphore v4 computes `nullifier = Poseidon(scope, identitySecret)`:

- **Scope** is the external nullifier — the relying party defines it, e.g. `hash(rp_domain, action, epoch)`. One agent identity produces exactly one nullifier per scope: this is the rate-limit and double-use guard.
- **Message** is the signal — bind it to a challenge nonce (and any request payload digest) so a proof cannot be replayed for a different request even within the same scope.
- The router is **`view` and stateless**; each relying party keeps its own nullifier store:

```solidity
mapping(uint256 scope => mapping(uint256 nullifier => bool used)) usedNullifiers;

function gate(uint8 tier, ISemaphore.SemaphoreProof calldata p) external {
    require(p.scope == myScope(), "wrong scope");
    require(router.verifyCompliance(tier, p), "invalid proof");
    require(!usedNullifiers[p.scope][p.nullifier], "already used");
    usedNullifiers[p.scope][p.nullifier] = true;
    // ... grant
}
```

We reject Semaphore's built-in `validateProof` (which burns nullifiers **globally per group**) because in a registry serving many relying parties, one service's verification must not consume an agent's ability to prove to another. This deviates from Semaphore's default single-app integration pattern and is therefore documented loudly, here and in the router's NatSpec.

Epoch-suffixed scopes give renewable allowances ("one anonymous call per agent per day": put the day number in the scope). Heavier anonymous rate-limiting (k-per-epoch with slashing) is what [RLN](https://github.com/Rate-Limiting-Nullifier) provides; noted in the roadmap.

## 4. Proof freshness: roots and history

Membership proofs are made against a Merkle root. Semaphore v4 accepts the group's current root, or a historical root within the group's configured `merkleTreeDuration` (default 1 hour) — the same root-history pattern World ID uses to tolerate proof-generation latency. Consequences:

- After any membership change (insert/removal), old roots stay provable for up to the duration window — bounded staleness by design.
- Relying parties with stricter needs can read `router.merkleTreeRoot(tier)` and require the proof's root to equal the current one.
- World ID's bridged 1-hour L1→L2 expiry produced real liveness issues; PoCA avoids the whole class by keeping groups native on the L2 (no bridging). One nuance to track: Semaphore's [Sep 2026 root-expiry fix](https://github.com/semaphore-protocol/semaphore/pull/1094) (historical roots previously expired measured from creation rather than replacement, so an idle group's just-replaced root could be instantly unprovable) is merged upstream but not yet in an npm release — the PoC pins the current release (`@semaphore-protocol/contracts` 4.14.3); adopt the fix release when published. This is a liveness nuisance, not a soundness issue.

## 5. Revocation and expiry

```mermaid
sequenceDiagram
    participant ACV as Verifier (or foundation policy)
    participant EAS as EAS predeploy
    participant RES as ComplianceResolver
    participant MGR as ComplianceSetManager
    participant K as Keeper (anyone)
    participant SEM as Semaphore

    ACV->>EAS: revoke(AgentCompliance uid)
    EAS->>RES: onRevoke(attestation)
    RES->>MGR: onRevoked(uid)
    MGR-->>K: emit RemovalRequired(tier, commitment)
    Note over EAS: Public track: revoked immediately,<br/>every lookup now fails
    K->>K: Rebuild LeanIMT from public members;<br/>compute sibling path
    K->>MGR: finalizeRemoval(uid, siblings)
    MGR->>SEM: removeMember(groupId, commitment, siblings)
    SEM-->>SEM: Root rotates
    Note over SEM: Private track: proofs against<br/>pre-removal roots die when<br/>the history window lapses
```

- **Revocation** (verifier withdraws the attestation, e.g. incident or discovered misrepresentation): public track reflects it in the same transaction; private track follows after `finalizeRemoval` plus the root-history window. This **revocation-latency window** — pending removal + ≤1h root history — is an explicit, quantified gap ([threat model §stale membership](05-threat-model.md)). `finalizeRemoval` is permissionless so liveness never depends on the foundation; a keeper watching `RemovalRequired` is the intended steady-state (roadmap).
- **Expiry** (attestation's `expirationTime` passes): the public track enforces it automatically on read. The PoC does **not** yet sweep expired members from groups — an honest, documented gap. Phase 2 adds an expiry sweep reusing the same two-phase path (anyone proves "uid expired" → mark pending → finalize). Until then, relying parties for whom expiry matters at ZK-level should cross-check the public track or demand short-validity attestations.
- **Re-attestation** after expiry/update inserts the agent's (possibly new) commitment under the new attestation UID; `refUID` chains the history.

## 6. Accountable anonymity (phase-2 sketch)

Regulated contexts may require that pseudonymous usage be *attributable under due process* (the framework's accountability dimension; see also IMDA's legal-responsibility discussion paper). Sketch, deliberately not in the PoC:

- At insertion, the agent (or resolver flow) publishes `Enc(pk_authority, attestationUID)` alongside the commitment — encrypted to a **threshold key** held by an incident-response council (t-of-n; e.g. foundation + independent verifiers + an ecosystem representative).
- A relying party's scope can require proofs from the escrowed sub-group only; an incident triggers council decryption of the specific ciphertext, unmasking one agent without weakening anyone else's privacy.
- Governance of "due process" is the hard part (who convenes, evidentiary threshold, transparency log of unmaskings); the cryptography is standard. World ID 4.0's OPRF-based nullifier design is prior art for threshold-operated privacy infrastructure.

## 7. Key management realities

- The Semaphore identity secret is a bearer credential for the private track. The PoC treats it as a single static key; compromise ⇒ revoke the attestation (removing the member) and re-attest with a fresh commitment. World ID 4.0's registry (multiple authorized keys, rotation, recovery) is the model for a v2 — tracked in the roadmap.
- `deployer` and agent operational keys are ordinary EOAs/smart accounts; nothing in PoCA prevents ERC-4337 smart accounts, and delegated attestations already keep verifiers gas-free.
