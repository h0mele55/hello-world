# Open-source landscape: what PoCA builds on

> **Independence disclaimer.** PoCA is an independent open-source project, not affiliated with or endorsed by IMDA, the AI Verify Foundation, or the Government of Singapore. See [02-imda-alignment.md](02-imda-alignment.md).

Research snapshot **verified 2026-09-21** (licenses checked against actual repositories where possible). Grouped by how each project relates to PoCA: **core dependency**, **pattern source** (we re-implement the idea, not the code), **integration surface** (things PoCA binds to), or **precedent**.

## 1. Core dependencies

| Project | License | Status (2026) | Role in PoCA | Caveat |
|---|---|---|---|---|
| [EAS — eas-contracts](https://github.com/ethereum-attestation-service/eas-contracts) / [eas-sdk](https://github.com/ethereum-attestation-service/eas-sdk) | MIT | Live as **OP Stack genesis predeploys** (`0x4200…20`/`0x4200…21`, [spec](https://github.com/ethereum-optimism/specs/blob/main/specs/protocol/predeploys.md)); used by Optimism governance, Human Passport | The attestation layer: schemas, expiry, revocation, `refUID` chains, resolver hooks, delegated + off-chain attestations | [easscan.org](https://optimism.easscan.org) is a hosted convenience — run your own indexer for availability |
| [Semaphore v4](https://github.com/semaphore-protocol/semaphore) | MIT | Active (PSE/EF); [audited 2024](https://semaphore.pse.dev/Semaphore_4.0.0_Audit.pdf) | The anonymity layer: groups (LeanIMT, dynamic depth ≤32), **member removal** (v3 lacked it), Poseidon nullifiers, snarkjs Groth16 proving in browser/Node | [Root-expiry fix #1094](https://github.com/semaphore-protocol/semaphore/pull/1094) (Sep 2026) is merged but unreleased — PoC pins 4.14.3, adopt the fix release when published; known footgun: `binary-merkle-root` circuit accepts a zero root beyond MAX_DEPTH |
| [OpenZeppelin Contracts v5](https://github.com/OpenZeppelin/openzeppelin-contracts) | MIT | Industry standard | `Ownable` etc. | — |
| [PSE zk-kit](https://github.com/privacy-scaling-explorations/zk-kit) | MIT | Active | LeanIMT + Poseidon primitives under Semaphore; `@zk-kit/semaphore-artifacts` ships proving artifacts (wasm/zkey) for fully offline proof generation | The separate `@zk-kit/artifacts` package is only a CDN downloader — use `semaphore-artifacts` for vendored files |
| [ERC-8004 "Trustless Agents"](https://eips.ethereum.org/EIPS/eip-8004) + [reference contracts](https://github.com/erc-8004/erc-8004-contracts) (ecosystem index: [awesome-erc8004](https://github.com/sudeepb02/awesome-erc8004)) | CC0 | Spec formally **Draft**, but canonical deployments live on 16+ chains **including Optimism** (IdentityRegistry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, ReputationRegistry `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`; audited by Cyfrin/Nethermind/EF; mainnet Jan 2026) | Public agent identity: PoCA attests **to** an `agentId` instead of inventing agent identity; roadmap: act as an ERC-8004 Validation-Registry validator with the EAS UID as the artifact | Draft status = interface churn risk; registration is permissionless, so raw agent counts include spam |
| [AI Verify](https://github.com/aiverify-foundation/aiverify) / [Project Moonshot](https://github.com/aiverify-foundation/moonshot) / [moonshot-cicd](https://github.com/aiverify-foundation/moonshot-cicd) | Apache-2.0 | Active (AI Verify Foundation) | Evidence generators: process checks, LLM benchmarks, red-teaming, CI-friendly JSON output — the contents behind `evidenceHash` | Tooling targets LLM apps today; IMDA's agentic testing starter kit is announced but unpublished — track it |

## 2. Worldcoin repositories (mirror source)

All under [github.com/worldcoin](https://github.com/orgs/worldcoin/repositories); MIT unless noted. The architectural lesson: **World ID 3.0's commitment-insertion design is sunsetting; 4.0 moved to issuer-signed credentials with native expiry/rotation** — independent validation of PoCA's EAS-centric shape.

| Repo | What it is | Reuse verdict for PoCA |
|---|---|---|
| [world-id-protocol](https://github.com/worldcoin/world-id-protocol) | **World ID 4.0**: `WorldIDRegistry` (multi-key, rotation, recovery), off-chain issuer-signed credentials with `issuerSchemaId` checked in-proof, OPRF nullifiers, session proofs for expiry checks | Highest-value study target; its issuer/schema-registry concept is what PoCA gets from EAS natively; OPRF nullifiers + multi-key identity are PoCA's v2 direction |
| [world-id-contracts](https://github.com/worldcoin/world-id-contracts) | v3 identity manager + router | Reference only — **no revocation exists in v3** (`deleteIdentities` absent), the exact flaw PoCA must not inherit |
| [world-id-state-bridge](https://github.com/worldcoin/world-id-state-bridge) | L1→L2 root propagation (`OpStateBridge`/`OpWorldID`), permissionless `propagateRoot` | Directly reusable **if** PoCA ever anchors sets on one chain and verifies on others; unnecessary while groups live natively on the target L2 |
| [signup-sequencer](https://github.com/worldcoin/signup-sequencer) + [semaphore-mtb](https://github.com/worldcoin/semaphore-mtb) | Rust batcher + gnark Groth16 batch-insertion prover (~11s per 100-leaf batch) | The scaling pattern when per-attestation `addMember` gas becomes the bottleneck — phase 4 |
| [idkit](https://github.com/worldcoin/idkit) (note: [idkit-js](https://github.com/worldcoin/idkit-js) archived 2026) | Multi-language client SDK | UX pattern for PoCA's SDK; don't depend — Worldcoin breaks interfaces roughly annually |
| [world-chain](https://github.com/worldcoin/world-chain) | OP Stack + reth chain; **PBH: Priority Blockspace for Humans** + free-gas allowance for verified users | Precedent for phase-4 "priority lanes for attested-compliant agents" on a purpose-built chain |

## 3. Pattern sources (⚠ copyleft — re-implement, never vendor)

| Project | License | Pattern PoCA borrows |
|---|---|---|
| [Human Passport](https://github.com/passportxyz) (ex-Gitcoin Passport) | Mixed; [eas-proxy](https://github.com/passportxyz/eas-proxy) is **AGPL-3.0** | Off-chain scoring → on-chain EAS attestations on Optimism behind a threshold gate; proof that EAS-based eligibility rails work at millions-of-users scale |
| [ERC-3643 / ONCHAINID](https://github.com/onchain-id/solidity) | **GPL-3.0** | The Trusted-Issuers-Registry ⁄ Claim-Topics-Registry separation — "who may attest" split from "what may be attested"; PoCA's `AccreditationRegistry` is this pattern, minimal and MIT |
| [Hats Protocol](https://github.com/Hats-Protocol/hats-protocol) | **AGPL-3.0** | Revocable, expiring role trees for accreditation governance; a Hats-gated resolver (`isWearerOfHat`) is a viable alternative accreditation backend if AGPL exposure is acceptable at the deployment layer |
| [RLN](https://github.com/Rate-Limiting-Nullifier) | MIT (circuits) | k-actions-per-epoch anonymous rate-limiting with slashing — the upgrade path beyond one-nullifier-per-scope; maintenance status unclear (possibly sunset at PSE) |

**License hygiene:** everything PoCA ships is MIT; AGPL/GPL projects above informed the *design* only. Deployments that *interact* with copyleft contracts on-chain are fine; forking their source into this repo is not.

## 4. Integration surfaces (the agent-auth ecosystem PoCA binds to)

These carry *identity and transport authentication*; none carries third-party compliance assurance — that is the layer PoCA adds.

| Surface | What it gives | How PoCA binds (roadmap) |
|---|---|---|
| [A2A protocol](https://github.com/a2aproject/A2A) (Linux Foundation, Apache-2.0; v1.0 with **Signed AgentCards**) | Discoverable agent metadata at a domain, domain-owner signed | Attest the AgentCard hash + domain inside the evidence bundle; resolvers/indexers verify card ↔ `agentId` consistency |
| [MCP authorization](https://modelcontextprotocol.io/specification/draft/basic/authorization) (OAuth 2.1) | Per-server resource authorization for tool access | An MCP authorization server mints tokens carrying the attestation UID as a claim; PoCA ships an MCP server exposing verify/prove tools so agents use the registry in-band |
| [Web Bot Auth](https://datatracker.ietf.org/doc/draft-meunier-webbotauth-httpsig-protocol/) (IETF draft; RFC 9421 HTTP message signatures) | Per-request cryptographic bot identity at the edge | Map the signing key to an attested `agentId`; CDNs/WAFs can then enforce "attested agents only" without touching a chain per request |
| [Agent Commerce Kit — ACK-ID](https://github.com/agentcommercekit) (Catena Labs, MIT) | DID/VC chain proving agent ↔ owner control | Issue the compliance claim as a VC in the ACK-ID chain, mirrored by the on-chain attestation |
| [x402](https://github.com/x402-foundation/x402) + Coinbase AgentKit (Apache-2.0) | Agent-native HTTP payments | Payment facilitators check the attestation before settling — compliance-gated commerce |
| [Visa Trusted Agent Protocol](https://github.com/visa/trusted-agent-protocol) | Signed agent→merchant intent (RFC 9421 family) | Same key-binding approach; note: open **spec**, OSI license unverified |
| [Veramo](https://github.com/decentralized-identity/veramo) (Apache-2.0, DIF, active) · [TrustVC](https://github.com/TrustVC/trustvc) (successor to Singapore GovTech's archived OpenAttestation) | W3C VC issuance for off-chain credential mirrors | Off-chain VC twin of the attestation for wallets/eIDAS-style flows; **use TrustVC, not OpenAttestation (archived Oct 2025)**, for the Singapore-aligned stack |

## 5. Platform: why Optimism

- **EAS is a genesis predeploy at fixed addresses across the entire Superchain** — the trust anchor ports to Base, World Chain, Unichain with zero redeployments ([predeploys spec](https://github.com/ethereum-optimism/specs/blob/main/specs/protocol/predeploys.md)).
- **Attestation-native governance culture**: Optimism's badgeholders, RetroPGF rounds and Citizens' House run on attestations (AttestationStation → EAS lineage), and OP-funded tooling exists to reuse ([voteagora's Ponder EAS indexer](https://github.com/voteagora/atlas-eas-indexer), [Ponder](https://github.com/ponder-sh/ponder), MIT).
- **World Chain precedent**: a purpose-built, ZK-identity-gated OP Stack chain operating inside the Superchain — the exact template for a future compliance-gated chain (OP Stack is MIT; Superchain standard terms: the greater of 2.5% of sequencer revenue or 15% of sequencer profit).

## 6. Explicitly unverified / watch-list

- Visa TAP's open-source license (spec public, LICENSE file unconfirmed).
- RLN maintenance status (conflicting signals; Status Network ships it, PSE lists it as wound down).
- IMDA's agentic-AI testing starter kit (announced, unpublished as of the snapshot date).
- AI TAP operational status (announced for Q3 2026 — verify before wiring `accreditationRef` semantics to it).
- ERC-8004 adoption figures (third-party trackers disagree wildly; treat counts as unreliable).
