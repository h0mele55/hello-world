# PoCA — Proof of Compliant Agenthood

**A decentralized identity and attestation registry on Optimism for AI agents whose deployments have been independently assessed against Singapore IMDA's *Model AI Governance Framework for Agentic AI*.**

Worldcoin's World ID answers *"is this a unique human?"* without revealing which human. PoCA mirrors that design for the agentic economy: accredited AI-testing firms issue **on-chain, revocable, expiring compliance attestations** for AI agents, and agents prove they hold one — either **publicly** (full provenance: who audited, against which framework version, with what evidence) or **pseudonymously**, via a Semaphore zero-knowledge membership proof that reveals the agent's risk tier and nothing else.

> ### ⚠️ Independence disclaimer
> PoCA is an independent open-source project. It is **not affiliated with, endorsed by, or approved by** the Infocomm Media Development Authority (IMDA), the AI Verify Foundation, or the Government of Singapore. A PoCA attestation records a third party's assessment of alignment with a pinned, publicly available framework version — it is **not a certification** and confers no official status. This repository paraphrases the framework and links to official sources; it reproduces none of its text.

## How it works

```
Accredited verifier ──attest──▶ EAS predeploy (0x4200…21, every OP Stack chain)
                                   │ onAttest
                                   ▼
                           ComplianceResolver ──▶ AccreditationRegistry (may this verifier attest?)
                                   │
                                   ▼
                           ComplianceSetManager ──addMember──▶ Semaphore group (per risk tier)
                                                                    ▲
Relying party ◀──true/false── ComplianceRouter ◀──ZK membership proof── Agent
```

- **Public track**: read the attestation from the EAS predeploy — attester, accreditation chain (`refUID`), framework version pin (`IMDA-MGF-AgenticAI-v1.5`), per-dimension coverage, evidence-bundle hash, expiry, revocation state.
- **Private track**: the agent proves *"I am a member of the tier-T attested set"* bound to the relying party's scope; a per-scope nullifier rate-limits reuse without identifying the agent.
- **Revocation is first-class** (the flaw in World ID 3.0 this design refuses to inherit): EAS `revoke()` → two-phase Semaphore member removal; attestations must expire.

## Repository map

| Path | What it is |
|---|---|
| [`docs/01-overview.md`](docs/01-overview.md) | Problem, Worldcoin analogy, actors, components, dual-track model |
| [`docs/02-imda-alignment.md`](docs/02-imda-alignment.md) | The framework's four dimensions → attestation schema → evidence mapping; AI TAP accreditation anchor; versioning policy |
| [`docs/03-architecture.md`](docs/03-architecture.md) | On-chain topology, EAS schemas, contract-by-contract spec, sequence diagrams, deployment plan |
| [`docs/04-identity-and-privacy.md`](docs/04-identity-and-privacy.md) | Identity layering (ERC-8004 / accountable entity / Semaphore), scope & nullifier semantics, revocation flow, accountable anonymity |
| [`docs/05-threat-model.md`](docs/05-threat-model.md) | Trust assumptions, attacks & mitigations, honest limits |
| [`docs/06-open-source-landscape.md`](docs/06-open-source-landscape.md) | The vetted open-source menu this project builds on (licenses, maturity, integration notes) |
| [`docs/07-roadmap.md`](docs/07-roadmap.md) | Phases, services (indexer, keeper, verifier portal, MCP/A2A bindings), open questions |
| [`contracts/`](contracts/) | Foundry PoC: `AccreditationRegistry`, `ComplianceResolver` (EAS), `ComplianceSetManager` (Semaphore), `ComplianceRouter` + tests against the real EAS & Semaphore contracts |
| [`sdk/`](sdk/) | TypeScript SDK skeleton: identity, attestation encode/read/check, ZK proof generation with offline artifacts + runnable demo |

## Quickstart

### Contracts (requires [Foundry](https://getfoundry.sh); solc 0.8.29)

```bash
git clone --recursive <this-repo> && cd hello-world/contracts
npm install            # Solidity deps: eas-contracts 1.9.0, @semaphore-protocol/contracts 4.14.3, OZ v5
forge build
forge test -vv         # 35 tests: attest→insert, revoke→two-phase removal, router verify, accreditation gating
forge script script/Deploy.s.sol   # dry-run; add --rpc-url/--broadcast for OP Sepolia (11155420)
```

If you cloned without `--recursive`: `git submodule update --init` (forge-std).

### SDK + offline ZK demo (Node ≥ 22)

```bash
cd sdk
npm install            # includes @zk-kit/semaphore-artifacts (~170 MB) for offline proving
npm run typecheck
npm run demo
```

The demo needs no chain and no network: it builds a tier-2 compliance set, generates and verifies a **real Groth16 membership proof** (~1 s), demonstrates nullifier-based rate-limiting, then simulates a revocation and shows the revoked agent can no longer prove while others still can.

## Design lineage (short version)

Built from verified research on: **World ID** (3.0's Semaphore sets and router semantics; 4.0's issuer-signed-credential shift, which independently validates the EAS-centric shape), **EAS** (genesis predeploy at the same address on every OP Stack chain — the reason this lives on Optimism), **Semaphore v4** (LeanIMT member removal makes revocation possible), **ERC-8004** (canonical agent identity registry, live on Optimism — PoCA attests *to* it rather than reinventing agent identity), and the **AI Verify Foundation** tooling (AI Verify, Project Moonshot) as evidence generators, with the **AI TAP** tester-accreditation programme as the real-world anchor for the accredited-verifier role. Full citations in [`docs/06-open-source-landscape.md`](docs/06-open-source-landscape.md).

## Status

Research prototype — unaudited, testnet-oriented, interfaces will change. The PoC intentionally leaves gaps that are documented rather than hidden (expiry sweeping, keeper service, delegated-attestation flow): see [`docs/05-threat-model.md`](docs/05-threat-model.md) and [`docs/07-roadmap.md`](docs/07-roadmap.md).

## License

[MIT](LICENSE). Copyleft projects referenced in the research (Hats, ONCHAINID, Human Passport's eas-proxy) informed the design only; no code from them is included.
