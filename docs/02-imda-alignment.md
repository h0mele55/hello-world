# Alignment with the IMDA Model AI Governance Framework for Agentic AI

> **Independence disclaimer.** PoCA is an independent open-source project. It is not affiliated with, endorsed by, or approved by the Infocomm Media Development Authority (IMDA), the AI Verify Foundation, or the Government of Singapore. A PoCA attestation records a third party's assessment of alignment with a pinned, publicly available framework version. It is not a certification and confers no official status.

## 1. The framework PoCA anchors to

- **Title:** *Model AI Governance Framework for Agentic AI* ("MGF for Agentic AI"), published by IMDA.
- **History:** v1.0 launched 22 January 2026 ([IMDA press release](https://www.imda.gov.sg/resources/press-releases-factsheets-and-speeches/press-releases/2026/new-model-ai-governance-framework-for-agentic-ai), [MDDI announcement](https://www.mddi.gov.sg/newsroom/singapore-launches-new-model-ai-governance-framework-for-agentic-ai--/)); updated to **v1.5** in May–June 2026 with input from 60+ organisations ([IMDA factsheet](https://www.imda.gov.sg/resources/press-releases-factsheets-and-speeches/factsheets/2026/updated-model-ai-governance-framework-for-agentic-ai)). The official PDF is published on [imda.gov.sg](https://www.imda.gov.sg/-/media/imda/files/about/emerging-tech-and-research/artificial-intelligence/mgf-for-agentic-ai.pdf).
- **Nature:** voluntary, non-binding best-practice guidance, maintained as a **living document**. The framework itself defines **no certification, labelling, or attestation mechanism** — which is precisely the space PoCA's *independent* attestation rails occupy.
- **Companion reading:** IMDA's [Discussion Paper on Legal Responsibility for AI Agents](https://www.imda.gov.sg/-/media/imda/files/about/emerging-tech-and-research/artificial-intelligence/agents-legal-responsibility.pdf) (May 2026), relevant to the accountable-entity binding below.

**Paraphrase-only policy.** IMDA's [terms of use](https://www.imda.gov.sg/terms-of-use) restrict reproduction of its materials and prohibit implying affiliation. This repository therefore paraphrases the framework in its own words, links to the official sources, and never embeds framework text on-chain or in metadata. Anyone implementing an assessment against the framework must work from the official PDF, not from this document.

## 2. The four dimensions, in our own words

The framework organises agentic-AI governance into four iterative dimensions (anomalies in operation feed back into re-assessment):

1. **Assess and bound the risks upfront.** Choose appropriate use cases and bound the agent's power by design: which tools it may call, what permissions it holds, the scope and reversibility of its actions, and how much autonomy it exercises. Risk is a function of *action-space × autonomy*.
2. **Make humans meaningfully accountable.** Put defined human approval checkpoints where they matter, allocate responsibility clearly across the value chain (platform providers vs system providers/application developers), and counter automation bias — including monitoring how often and how fast humans actually override.
3. **Implement technical controls and processes.** Lifecycle controls including: **a unique, cryptographically verifiable identity for each agent**; least-privilege, scoped, time-bound, non-transferable authorisations with recorded delegations; sandboxing and allowlisted tools/services; baseline, agent-level and workflow-level testing; monitoring and anomaly detection; progressive rollout; and change review when models or agents are updated.
4. **Enable end-user responsibility.** Tell users they are dealing with an AI agent, what it can do, what data it touches, and give them a working escalation channel when something goes wrong.

That dimension 3 explicitly calls for verifiable per-agent identity is the single strongest reason a decentralized identity registry is a natural companion to this framework rather than an imposition on it.

## 3. The mapping: dimensions → attestation schema → evidence

The `AgentCompliance` attestation (schema details in [03-architecture.md](03-architecture.md)) encodes the *outcome* of an assessment. The assessment itself happens off-chain, performed by an accredited verifier against the official framework text. This table is the contract between the two:

| Dimension (paraphrased expectations) | Schema field(s) | Evidence in the bundle (hashed into `evidenceHash`) | Checked by |
|---|---|---|---|
| **1 — Risks bounded upfront**: documented use-case selection; bounded action space, tool access, permissions; autonomy limits; reversibility analysis | `dimensionsBitmap` bit 0; `riskTier` (the assessed autonomy × action-space envelope); `agentVersionHash` (binds the exact assessed configuration) | Risk assessment report; tool/action inventory with allowlists; autonomy & reversibility matrix | Verifier off-chain; tier and version binding recorded on-chain |
| **2 — Humans meaningfully accountable**: named accountable entity; approval checkpoints; value-chain responsibility allocation; automation-bias countermeasures | `dimensionsBitmap` bit 1; `deployer` (address of the accountable legal entity) | Accountability matrix (who answers for what, incl. vendors); human-checkpoint specification; override-rate monitoring plan | Verifier off-chain; accountable-entity binding on-chain |
| **3 — Technical controls and processes**: verifiable agent identity; least-privilege scoped authorisations; sandboxing & allowlisting; testing at baseline/agent/workflow level; monitoring; progressive rollout; change review | `dimensionsBitmap` bit 2; `agentId` (ERC-8004 identity); `identityCommitment` (Semaphore identity); `agentVersionHash`; `evidenceHash` | [AI Verify](https://github.com/aiverify-foundation/aiverify) process checks; [Project Moonshot](https://github.com/aiverify-foundation/moonshot) / [moonshot-cicd](https://github.com/aiverify-foundation/moonshot-cicd) test runs (benchmarks, red-teaming incl. prompt-injection suites); logging & monitoring architecture; rollout and change-review procedure | Verifier off-chain; identity bindings on-chain |
| **4 — End-user responsibility**: disclosure that users face an AI agent, of its action range and data access; escalation contact | `dimensionsBitmap` bit 3; discoverable disclosure surface via the agent's ERC-8004 registration file / A2A AgentCard | Disclosure/UX review; published escalation channel and malfunction contact | Verifier off-chain; discoverability via the public agent registration |

Conventions:

- `dimensionsBitmap` bit *i* set = the verifier assessed dimension *i+1* and found the deployment aligned at the attested tier. The PoC keeps this binary per dimension; a per-dimension maturity-level encoding is sketched as schema v2 in [07-roadmap.md](07-roadmap.md).
- `riskTier` ∈ {1, 2, 3} = the envelope the agent is attested to operate within (1 = narrow action space and human approval on consequential actions → 3 = broad action space with substantial autonomy). Higher tiers should demand strictly more evidence; tier definitions are governance policy, versioned alongside the schema, not contract logic.
- **The evidence bundle** is a content-addressed manifest (e.g. an IPFS DAG): the manifest lists each artifact (report, test-run JSON, config snapshot) with its hash; `evidenceHash` commits to the manifest root. Nothing sensitive goes on-chain — verification of the bundle's contents is an off-chain act between parties the deployer chooses to share it with.

## 4. Evidence tooling: the AI Verify stack

The natural evidence generators are the open-source tools from the [AI Verify Foundation GitHub org](https://github.com/aiverify-foundation) (Apache-2.0): **AI Verify** (process checks + technical tests), **Project Moonshot** (LLM benchmarking and red-teaming), and **moonshot-cicd** (containerised runs emitting machine-readable JSON, built for CI/CD gating — ideal for producing reproducible artifacts that hash cleanly into evidence bundles). IMDA has announced work toward agentic-AI testing guidance building on its LLM-app testing Starter Kit; when that lands, its test set should become the default expectation for dimension-3 evidence. PoCA does not hard-code any tool: the schema commits to evidence *hashes*, and verifier policy decides what a bundle must contain.

## 5. Accreditation anchor: AI TAP

Who may attest is PoCA's most safety-critical question. The design mirrors reality in Singapore's assurance ecosystem:

- The **[Global AI Assurance Sandbox](https://aiverifyfoundation.sg/ai-assurance/)** (successor to the Feb 2025 pilot that paired 17 deployers with 16 specialist testers) matches AI application deployers — now including agentic applications — with independent technical testers.
- The **[AI Tester Accreditation Programme (AI TAP)](https://aiverifyfoundation.sg/tester-accreditation/)** (announced May 2026) accredits AI testing *firms*, with **12-month renewable validity**.

PoCA's `AccreditationRegistry` mirrors that shape: the foundation grants a verifier an on-chain accreditation with an **expiry (default: 12 months)** and an `accreditationRef` — a hash referencing the verifier's real-world credential (e.g. an AI TAP certificate identifier), so on-chain accreditation can track off-chain accreditation without reproducing it. PoCA accreditation is the foundation's own act; holding AI TAP or any other credential is an input to that decision, not an automatic right.

## 6. Versioning and re-attestation policy

A compliance claim is meaningless without a version pin — the framework moved v1.0 → v1.5 within four months of launch.

- Every attestation carries `frameworkVersion` (the PoC pins the string `IMDA-MGF-AgenticAI-v1.5`).
- Every attestation carries `agentVersionHash`: a hash of the assessed deployment configuration (model identifiers, scaffold/orchestration code version, tool allowlist, system-prompt bundle). **If the deployment changes materially, the attestation no longer describes it** — the framework's own change-review expectation applies, and the deployer should seek re-attestation. Relying-party mitigations for the gap between "changed" and "re-attested" are covered in [05-threat-model.md](05-threat-model.md).
- Re-attestations reference the prior attestation via EAS `refUID`, producing an auditable assessment history per agent.
- When IMDA publishes a new framework version, existing attestations stay valid until expiry but are visibly pinned to the older version; relying parties choose their own acceptance policy (e.g. "v1.5 or later only").

## 7. What PoCA must never claim

- No "IMDA certified", "IMDA approved", "IMDA compliant" language — on-chain, in metadata, or in marketing. The accurate claim is: *"an accredited independent verifier attested this deployment's alignment with the publicly available IMDA MGF for Agentic AI, version X, on date Y, with evidence Z — and that attestation is currently unrevoked and unexpired."*
- No IMDA or AI Verify Foundation logos or marks.
- No reproduction of framework text in this repository, in attestation metadata, or anywhere on-chain.
