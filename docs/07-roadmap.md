# Roadmap

> **Independence disclaimer.** PoCA is an independent open-source project, not affiliated with or endorsed by IMDA, the AI Verify Foundation, or the Government of Singapore. See [02-imda-alignment.md](02-imda-alignment.md).

## Phase 0 — this repository (done)

Architecture + research docs; skeletal PoC: four contracts compiling and unit-tested against the real EAS and Semaphore contracts; TypeScript SDK skeleton with a fully offline ZK proof demo (identity → group → Groth16 proof → verify → simulated revocation).

## Phase 1 — testnet pilot (OP Sepolia)

- Deploy via `contracts/script/Deploy.s.sol`; register schemas on the predeploy SchemaRegistry; publish addresses + schema UIDs in this repo.
- **Indexer + explorer**: [Ponder](https://github.com/ponder-sh/ponder) app indexing both schemas, `AccreditationRegistry` events, and `MemberAdded`/`RemovalRequired`; a minimal explorer answering "is agent X attested, by whom, until when?" — reading the registry (not the mirror attestation) as the accreditation source of truth.
- **Removal keeper**: a small service watching `RemovalRequired`, rebuilding the LeanIMT from indexed members, and calling `finalizeRemoval`.
- **Pilot cohort**: 2–3 friendly testing firms as mock-accredited verifiers; attest a handful of real agent deployments (internal agents are fine) with genuine [Moonshot](https://github.com/aiverify-foundation/moonshot) evidence bundles to pressure-test the evidence-manifest format.
- SDK hardening: implement `requestAttestation` (delegated-attestation round trip), `submitToRouter`, group sync from the indexer.

## Phase 2 — production shape

- **Expiry sweep**: permissionless "prove uid expired → mark pending → finalize" path reusing the two-phase removal machinery, closing the ZK-track expiry gap in [05-threat-model.md](05-threat-model.md).
- **Verifier portal**: evidence bundle assembly (hashing, IPFS pinning), EIP-712 delegated attestation signing, revocation console.
- **Automated verification (AVA)**: machine-checkable pre-assessment as CI for human attestations (AVA-0), then accredited class-M attestations for tier 1 with reproducible, receipted, third-party-auditable execution; judgment automated via the Jev deciding-leg architecture (grill-me doctrine elicitation, calibration-gated ladder) — full design in [09-automated-verifier.md](09-automated-verifier.md).
- **Accountable anonymity**: threshold-encrypted attestation-UID escrow + incident-council process ([design sketch](04-identity-and-privacy.md#6-accountable-anonymity-phase-2-sketch)).
- **Schema v2**: per-dimension maturity levels (packed `uint8[4]`) replacing the binary bitmap; new schema UID, parallel operation, indexer merges.
- **ERC-8004 integration**: optional resolver existence-check of `agentId`; act as a Validation-Registry validator publishing the EAS UID as the validation artifact.
- **In-band agent UX**: MCP server exposing `verify_agent_compliance` / `prove_my_compliance` tools; A2A Signed-AgentCard binding recorded in evidence bundles; Web Bot Auth key → `agentId` mapping for edge enforcement.

## Phase 3 — mainnet & governance hardening

- Two independent contract audits; deploy to OP Mainnet.
- Foundation ownership → multisig + timelock; published accreditation criteria and revocation policy; transparency log of accreditation decisions.
- Verifier onboarding through the real assurance ecosystem (firms emerging from the [Global AI Assurance Sandbox](https://aiverifyfoundation.sg/ai-assurance/); accreditation informed by [AI TAP](https://aiverifyfoundation.sg/tester-accreditation/) once live).
- Multi-verifier quorums for tier 3; verifier staking/slashing economics.
- Superchain replication (Base, World Chain) — same predeploys, same bytecode.

## Phase 4 — exploration

- **Scaling inserts**: batch insertion with SNARK-proven updates if per-attestation gas binds (the [signup-sequencer](https://github.com/worldcoin/signup-sequencer) + [semaphore-mtb](https://github.com/worldcoin/semaphore-mtb) pattern).
- **Nullifier hardening**: OPRF-based nullifiers and multi-key agent identities with rotation/recovery (the [World ID 4.0](https://github.com/worldcoin/world-id-protocol) pattern); RLN-style k-per-epoch anonymous rate limits.
- **Runtime binding**: TEE-attested inference / attested runtimes to shrink the assessed-vs-running gap — the strongest possible answer to the stale-compliance limit.
- **A dedicated chain?** Only if demand exists: an OP Stack chain with priority blockspace / fee subsidies for attested-compliant agents (World Chain's PBH, mirrored). The Superchain makes this a deployment decision, not an architecture change.

## Open questions

1. **Tier definitions as governance artifacts** — who maintains the tier-1/2/3 criteria document the `riskTier` field points at, and how are updates versioned? (Proposal: versioned in this repo, referenced by hash in schema metadata.)
2. **Evidence-manifest standard** — adopt/define a minimal JSON manifest schema so bundles are comparable across verifiers; alignment with [moonshot-cicd](https://github.com/aiverify-foundation/moonshot-cicd) output is the natural start.
3. **IMDA's agentic testing starter kit** (announced, unpublished) — when it lands, does it become the dimension-3 evidence baseline?
4. **Legal posture of attestations** — engage counsel on verifier liability and on the wording relying parties may attach to PoCA checks (IMDA's legal-responsibility discussion paper is the reference frame).
5. **Cross-chain reads** — native groups per chain vs one canonical set + state bridging ([world-id-state-bridge](https://github.com/worldcoin/world-id-state-bridge) pattern): revisit when a second chain deployment is real.
6. **Should accreditation itself decentralize** (stake-weighted or DAO-elected verifier admission) or stay a curated registry mirroring real-world accreditation? Curated is honest for v1; revisit with adoption.
