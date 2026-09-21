# AVA — the Automated Verifier Agent

> **Independence disclaimer.** PoCA is an independent open-source project, not affiliated with or endorsed by IMDA, the AI Verify Foundation, or the Government of Singapore. See [02-imda-alignment.md](02-imda-alignment.md).

## 1. Why an automated verifier

Human accredited verifiers are PoCA's trust anchor, but they are also its bottleneck and its least inspectable component:

- **Scale.** Attestations expire, agents update, and re-attestation churn grows with every deployed agent. A human firm reviewing evidence bundles does not scale to an agent economy; an assessment pipeline does.
- **Verifiability asymmetry.** Today the *claim* is cryptographically verifiable (four `eth_call`s) but the *assessment behind it* is auditable only socially — you trust the firm's accreditation. A machine verifier can invert that: its ruleset is public, its execution is receipted, and its verdicts are reproducible by anyone who re-runs the pinned pipeline.
- **Continuity.** Point-in-time human assessment plus a 6–12-month expiry leaves long dark windows. An automated verifier can re-assess on every configuration change and feed continuous-assurance addenda between full attestations.

**AVA (Automated Verifier Agent)** is that pipeline: software, operated by an accountable legal entity, accredited like any verifier — but whose every assessment is independently re-executable and auditable by third parties.

## 2. The honest boundary: what a machine may attest

Full automation of *judgment* is the oracle problem wearing a lab coat. The design refuses it. Per IMDA MGF dimension, the mechanically checkable share differs:

| Dimension | Machine-checkable (deterministic) | Judgment (human-only) |
|---|---|---|
| 1 — Risks bounded upfront | Tool allowlist present and pinned; action-space declaration schema-valid; autonomy config within the declared tier envelope; reversibility classes declared | Whether the bounds are *appropriate* for the use case |
| 2 — Human accountability | Named owner exists; checkpoint configuration present; override-rate monitoring demonstrably emitting | Whether accountability is *meaningful* rather than nominal |
| 3 — Technical controls | The strongest automation surface: run pinned [Moonshot / moonshot-cicd](https://github.com/aiverify-foundation/moonshot-cicd) suites against the live endpoint (prompt-injection resistance, guardrail bypass, tool-use accuracy) with thresholds; verify tool-manifest pins; probe that logging emits; change-review config present | Whether the control *architecture* is sound beyond what probes reach |
| 4 — End-user responsibility | Disclosure strings present at declared surfaces (probe the endpoint/AgentCard); escalation channel resolves and responds | Whether disclosure is *comprehensible* to real users |

This yields **assurance classes**, encoded in the accreditation scheme string rather than new contract logic:

- **Class M (machine)** — AVA alone. Everything attested is deterministically checkable. Capped at **tier 1** by foundation policy.
- **Class H (human)** — today's accredited-verifier attestation.
- **Class M+H (co-attestation)** — required for **tiers 2–3**: AVA attests the machine-checkable evidence; a human verifier attests the judgment dimensions; the two attestations reference each other via `refUID`, and relying-party policy demands the pair. Between full M+H cycles, AVA issues M-class *surveillance addenda* so the dark window closes.

When IMDA's announced **agentic-AI testing starter kit** publishes, it becomes the canonical source for AVA's dimension-3 ruleset — the framework's own tests, executed verbatim, receipted.

## 3. Architecture

### 3.1 Policy-as-code ruleset

The entire assessment logic is a versioned, public artifact: `ruleset.yaml` + threshold tables + pinned test-suite references, hashed to `rulesetHash`. Governance of ruleset changes sits with the foundation (versioned releases, published diffs, timelock before a new version may attest). **A verdict is meaningless without its ruleset version; every AVA attestation binds one.**

### 3.2 Deterministic runners and the transcript

AVA orchestrates container-pinned runners (moonshot-cicd images referenced by digest) over two inputs: the deployer's **evidence bundle** (its manifest root = `evidenceHash`, so the input set is frozen) and the agent's **live endpoint**. Every step emits a signed record into an **execution transcript**:

- hash-chained, Ed25519-signed step receipts (input digests → action → output digest) — deliberately **pipelock-compatible**, the receipt format Inflect already ingests;
- the transcript root is included in the final evidence bundle, so the on-chain `evidenceHash` commits to *the assessment's own execution history*, not just its inputs.

**The nondeterminism honesty clause:** where scoring uses an LLM judge, bit-reproducibility is not available. AVA therefore (a) prefers deterministic metrics wherever they exist, and (b) treats judge outputs as *signed recorded inputs* in the transcript — auditable and re-runnable within a policy-defined tolerance band ε, but never claimed as proven computation. Re-execution that lands outside ε is a dispute trigger, not noise.

### 3.3 Verifiability ladder

1. **Level 0 — reproducibility (launch).** Public ruleset + pinned runners + frozen inputs ⇒ anyone with bundle access re-runs the assessment and compares verdicts. Auditing = re-execution.
2. **Level 1 — receipts (launch).** The signed transcript makes each step non-repudiable and selectively disclosable without re-running everything.
3. **Level 2 — TEE execution.** The pipeline runs in an enclave; the quote binds the code measurement (pipeline image digest) to the verdict, and the quote lands in the bundle. Third parties verify *which code* produced the verdict without re-running it. On-chain quote verification (e.g. the Automata DCAP attestation contracts — to be evaluated, not yet verified by this project) enables a future resolver variant that refuses AVA-scheme attestations lacking a valid quote.
4. **Level 3 — zk (research).** Prove "verdict = ruleset R applied to inputs with root E" in a zkVM for the deterministic subset. Explicitly out of reach for LLM-judged steps; those remain Level-1 receipted inputs.

### 3.4 On-chain shape: no contract changes for v1

AVA is *just a verifier address*:

- The foundation accredits it with scheme `"PoCA-AVA-v1"` and `accreditationRef = H(operatorId, pipelineImageDigest, rulesetHash)` — **accreditation binds a specific code version**. Upgrading AVA = new grant; a bad version is revoked without killing the program, and every historical attestation still names exactly which version issued it.
- The machine transcript, quote, and ruleset reference all live inside the evidence bundle, which `evidenceHash` already commits to. The existing `ComplianceResolver`, schemas, and relying-party checks work unchanged; assurance class is read from the attester's accreditation scheme.
- Optional hardening later: a resolver variant enforcing TEE quotes for AVA-scheme attesters (Level 2+), and a foundation policy contract capping class-M attestations at tier 1 on-chain rather than by convention.

### 3.5 Transparency log — auditability of what AVA *doesn't* say

Selective silence is the subtle failure mode of any verifier. Countermeasures:

- AVA publishes **every completed assessment — passes and fails** — as off-chain EAS attestations in an append-only log whose head is periodically anchored on-chain.
- The deployer receives a signed **submission receipt** the moment an assessment is requested; a receipt with no corresponding published result is cryptographic evidence of suppression.
- Human accredited verifiers perform **sampling audits**: random re-review of AVA verdicts (the same pattern as Inflect's `agent-proposal-sample-audit` job, applied one level up). Sampling rates are foundation policy, published.

## 4. Accountability: the agent has an operator, and the agent is itself attested

Software cannot bear liability, and the IMDA framework's second dimension applies to the verifier too:

- **The operator is the accountable entity.** A legal person (an AI-testing firm — the entity AI TAP would accredit in the real world) operates AVA; the on-chain accreditation names operator + code version, and revocation reaches both.
- **AVA eats the dogfood.** AVA is an agent: it is registered (ERC-8004), carries its own PoCA attestation — bootstrapped by a *human* accredited verifier to break the chicken-and-egg — runs under kill-switch semantics, and emits the same receipts it demands of others. When operated against an Inflect tenant, it is a `RegisteredAgent` like any other, subject to the full gate chain.

## 5. Inflect integration deltas

The [integration plan](08-inflect-integration.md) barely changes — AVA slots into seams already built:

- **Input:** AVA consumes the step-7 evidence bundle via the `poca-bundle` export API; nothing new to build on the deployer side.
- **Receipts:** AVA's execution transcript posts to the existing `agent-receipts` endpoint (`src/lib/mcp/receipt-verification.ts` verifies Ed25519 today) — the tenant sees the assessment happen step-by-step in its own evidence timeline.
- **Verdict consumption:** identical — an AVA attestation is verified by the same four reads; gate 6 only additionally reads the accreditation scheme to apply class policy (M ⇒ tier-1 cap; tiers 2–3 require the `refUID`-linked H co-attestation).
- **Roadmap placement:** extends [step 9](08-inflect-integration.md#step-9--verifier-portal--eip-712-delegated-attestation-inflect--poca) (the portal's assessment form becomes AVA's judgment-dimension companion) and [step 10](08-inflect-integration.md#step-10--continuous-assurance--outbound-zk-pilot-inflect--poca) (surveillance addenda are the continuous-assurance feed).

## 6. Threat-model deltas

| Threat | Answer |
|---|---|
| **Goodhart / benchmark gaming** — agents tuned to pass the public ruleset | Hold-out suites (private per epoch, published after rotation); ruleset rotation; class M capped at tier 1; human sampling audits catch teach-to-the-test artifacts |
| **TEE compromise** | Defense in depth: reproducibility (Level 0) and receipts (Level 1) survive a broken enclave; a quote is one signal, never the only one |
| **Ruleset capture** — whoever writes the rules owns the registry | Foundation governance with versioned public releases, diffs, and timelock; accreditation binds ruleset hash, so a captured rule change is a *visible new version*, revocable independently |
| **LLM-judge nondeterminism** | Judge outputs are signed inputs, not proven computation; ε-band re-execution; deterministic metrics preferred; disputes escalate to human review |
| **Operator suppression / cherry-picking** | Transparency log + deployer submission receipts + sampling audits (§3.5) |
| **AVA availability** | An outage delays new assessments only; existing attestations, expiries, and revocations live on-chain and are unaffected |
| **Version sprawl** | One active accredited version at a time per operator (foundation policy); old versions' grants expire naturally |

## 7. Phasing

| Phase | What ships | Trust change |
|---|---|---|
| **AVA-0 — CI mode** | The pipeline runs as *pre-assessment* gating human attestation: verifiers only sign bundles that passed machine checks; transcript included in the bundle | None — humans still sign everything; immediate quality floor |
| **AVA-1 — class M** | AVA accredited (`PoCA-AVA-v1`), issues tier-1 machine attestations + surveillance addenda; transparency log live; reproducibility + receipts (Levels 0–1) | New, bounded: machine-only claims, lowest tier, fully re-executable |
| **AVA-2 — TEE** | Enclave execution, quotes in bundles; optional quote-checking resolver variant | Code identity becomes cryptographic, not procedural |
| **AVA-3 — co-attestation & zk** | M+H required for tiers 2–3 end-to-end; zkVM proofs for the deterministic subset | Judgment stays human, everything mechanical becomes provable |

The deliberately boring conclusion: AVA never replaces the accreditation layer — it makes one verifier *radically more inspectable* than any human firm can be, and it is held to every standard it enforces.
