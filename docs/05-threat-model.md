# Threat model

> **Independence disclaimer.** PoCA is an independent open-source project, not affiliated with or endorsed by IMDA, the AI Verify Foundation, or the Government of Singapore. See [02-imda-alignment.md](02-imda-alignment.md).

## 1. Trust assumptions

| Actor / component | Assumed | Recourse if violated |
|---|---|---|
| Foundation (registry owner) | Accredits competent, independent verifiers; revokes when warranted | Everything is public: bad accreditations are visible on-chain; governance hardening (multisig, timelock, published criteria) is roadmap phase 3 |
| Accredited verifiers | Assess honestly and competently against the pinned framework version | Accreditation revocation (immediate, on-chain); `refUID` audit trail; economic recourse (staking/slashing) is roadmap |
| EAS predeploys | Behave per [eas-contracts](https://github.com/ethereum-attestation-service/eas-contracts) semantics | Protocol-level assumption of the OP Stack chain itself |
| Semaphore v4 | Sound circuits + honest-majority Groth16 trusted setup; audited ([PSE audit, 2024](https://semaphore.pse.dev/Semaphore_4.0.0_Audit.pdf)) | Pin audited releases (PoC: 4.14.3) and adopt the [Sep 2026 root-expiry fix](https://github.com/semaphore-protocol/semaphore/pull/1094) once released; circuit bugs are systemic risk shared with the whole Semaphore ecosystem |
| OP Stack chain | Live, censorship-resistant enough for attest/revoke transactions | Standard L2 assumptions; sequencer censorship delays revocations too (worth naming) |
| Relying parties | Implement scope discipline and their own nullifier stores | SDK helpers + loud documentation; a sloppy RP harms itself, not the registry |

## 2. Attacks and mitigations

### Issuance layer

- **Rogue verifier attests a non-compliant agent.** Highest-impact attack. Mitigations: accreditation is revocable and expiring (12-month default, mirroring AI TAP); every attestation publicly names its attester and chains to its accreditation via `refUID`, so one bad attestation exposes the verifier's entire book to scrutiny; foundation revokes → all *future* attesting stops instantly, and existing attestations from that verifier can be revoked in bulk by policy. Roadmap: verifier staking with slashing, multi-verifier quorums for tier 3.
- **Deployer–verifier collusion.** Same surface with less deniability. Mitigations as above, plus (roadmap) randomized verifier assignment through an assurance-sandbox-style pool for high tiers, and publication of evidence-manifest formats so third parties can spot vacuous bundles.
- **Verifier key compromise.** Attacker attests arbitrary agents until detected. Mitigations: revoke accreditation (one transaction); bulk-revoke the window's attestations; delegated attestations (EIP-712) let verifiers keep signing keys cold. Detection: indexers alerting on attestation-rate anomalies (roadmap).
- **Accreditation-mirror mismatch.** The EAS `VerifierAccreditation` attestation is cosmetic; only `AccreditationRegistry` gates. A mismatch (revoked registry entry, live mirror attestation) could mislead naive UIs. Mitigation: indexers must read the registry as the source of truth; documented here and in the contract NatSpec.

### Validity layer

- **Stale compliance — the agent changed after assessment.** The central epistemic limit of any point-in-time audit, agentic AI especially (a model swap or prompt change alters behavior wholesale). PoCA's containment: `agentVersionHash` binds the attestation to the assessed configuration, so a changed deployment is *provably outside* its attestation the moment anyone can show the running config differs; short `expirationTime` bounds the damage window; the framework's own change-review expectation makes "update ⇒ re-attest" the attested process itself. **Residual risk is real and stated: PoCA attests the assessed configuration, not the runtime.** Runtime attestation (TEE quotes, attested inference) is the long-term answer — roadmap phase 4.
- **Expired-but-unswept set membership.** Public track enforces expiry on read; the PoC's Semaphore groups do not yet auto-remove expired members, so an expired agent can still produce tier-membership proofs until swept. Documented honestly in [04-identity-and-privacy.md](04-identity-and-privacy.md#5-revocation-and-expiry). Mitigations now: relying parties needing hard expiry cross-check the public track (the SDK exposes both in one call), or accept only short-validity attestations; mitigation next: permissionless expiry sweep (phase 2).
- **Revocation-latency window.** Between `revoke` and `finalizeRemoval` + root-history lapse (≤ ~1h + keeper latency), a revoked agent can still prove membership. Bounded, quantified, and shrinkable (keeper SLA, shorter `merkleTreeDuration`). Public track is exact from the revoke transaction — high-stakes relying parties should consult it.

### Proof layer

- **Proof replay.** Scope binds the relying party + action; message binds the challenge nonce; RP nullifier store rejects reuse. All three are needed; the SDK makes the safe pattern the default.
- **Cross-RP nullifier linkage.** Distinct scopes produce unlinkable nullifiers, so cross-service correlation via the proof layer alone is impossible; collusion at the metadata layer (timing, IPs) remains — standard anonymity-set caveats, honest in [04 §1](04-identity-and-privacy.md#1-three-identity-layers-one-binding).
- **Tiny-anonymity-set deanonymization.** Early groups are small; insertion timing correlates commitments to attestations *by design* (public binding). The private track's value grows with adoption; relying parties should not promise agents more anonymity than set size supports.
- **Agent identity-secret theft.** Bearer credential: thief proves as the victim until revocation. Response: revoke → two-phase removal; re-attest fresh commitment. Multi-key identities with rotation (World ID 4.0 pattern) are roadmap.
- **Sybil within the registry.** One attestation = one commitment = one member (enforced via the UID → commitment map); an entity with many attested agents has many members — *legitimate by design* (PoCA is not personhood). Per-scope nullifiers are the anonymous-rate-limit; RLN-style k-per-epoch limits are roadmap.

### Governance layer

- **Foundation key compromise / malicious foundation.** Owner can accredit attackers or revoke honest verifiers (griefing); owner cannot forge attestations from others, cannot un-revoke an attestation, and cannot silently rewrite history — everything is evented. Mitigations: multisig + timelock + published accreditation criteria (phase 3); ultimately, competing registries can fork the (MIT) stack — exit is credible.
- **Griefing `finalizeRemoval`.** Permissionless but constrained: only attestation UIDs already marked `removalPending` can be finalized (the tier and commitment are read from storage, so a caller cannot aim the removal at a different group), and LeanIMT verifies the sibling path — wrong paths revert. No arbitrary-member removal exists. Keying by UID rather than commitment specifically prevents a cross-tier grief where revocation in one tier is used to remove the same identity's still-valid membership in another.
- **Metadata/PII exposure.** On-chain: addresses, hashes, tier, bitmap, version string — no evidence contents, no personal data. Evidence bundles live off-chain, shared bilaterally; `evidenceHash` only commits. GDPR/PDPA posture: keep it that way; never put even hashed PII of natural persons into schema fields.

## 3. What PoCA explicitly does not defend against

- A deployment faithfully matching its attested configuration but behaving badly anyway — an assessment-quality problem, not a registry problem; the registry's contribution is making the assessor and evidence trail public and revocable.
- Off-chain misrepresentation ("PoCA-attested!" claims by agents that aren't) — verify on-chain, not on websites; the SDK's check is one call.
- Legal weight of attestations. PoCA records that an assessment happened and what it claimed; whether that satisfies any duty of care is between deployers, verifiers, and their jurisdictions (see IMDA's legal-responsibility discussion paper).
