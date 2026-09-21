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

- **Class M (machine)** — AVA alone, deterministic checks only. Capped at **tier 1** by foundation policy.
- **Class J (judged)** — machine checks **plus** the [Jev judgment layer (§4)](#4-the-judgment-layer-jev-and-the-grill-me-bank): doctrine-driven verdicts (`CONCUR/ESCALATE/REFUSE/ABSTAIN`) whose authority is earned along a calibration-gated mode ladder, with automatic escalation to humans on low confidence or contest. May attest **up to tier 2**, only with surveillance addenda and an elevated human-sampling rate.
- **Class H (human)** — today's accredited-verifier attestation.
- **Class M+H / J+H (co-attestation)** — required for **tier 3**: AVA attests the machine-checkable (and Jev-judged) evidence; a human verifier attests the judgment dimensions; the attestations reference each other via `refUID`, and relying-party policy demands the pair. Between full cycles, AVA issues surveillance addenda so the dark window closes.

When IMDA's announced **agentic-AI testing starter kit** publishes, it becomes the canonical source for AVA's dimension-3 ruleset — the framework's own tests, executed verbatim, receipted.

## 3. Architecture

### 3.1 Policy-as-code ruleset

The entire assessment logic is a versioned, public artifact: `ruleset.yaml` + threshold tables + pinned test-suite references, hashed to `rulesetHash`. Governance of ruleset changes sits with the foundation (versioned releases, published diffs, timelock before a new version may attest). **A verdict is meaningless without its ruleset version; every AVA attestation binds one.**

### 3.2 Deterministic runners and the transcript

AVA orchestrates container-pinned runners (moonshot-cicd images referenced by digest) over two inputs: the deployer's **evidence bundle** (its manifest root = `evidenceHash`, so the input set is frozen) and the agent's **live endpoint**. Every step emits a signed record into an **execution transcript**:

- hash-chained, Ed25519-signed step receipts (input digests → action → output digest) — deliberately **pipelock-compatible**, the receipt format Inflect already ingests;
- the transcript root is included in the final evidence bundle, so the on-chain `evidenceHash` commits to *the assessment's own execution history*, not just its inputs.

**The nondeterminism honesty clause:** where scoring uses a model judge, bit-reproducibility is not available. AVA therefore (a) prefers deterministic metrics wherever they exist, and (b) treats judge outputs as *signed recorded inputs* in the transcript — auditable and re-runnable within a policy-defined tolerance band ε, but never claimed as proven computation. Re-execution that lands outside ε is a dispute trigger, not noise. The [typed judgment layer in §4](#4-the-judgment-layer-jev-and-the-grill-me-bank) sharpens this considerably — ε becomes a well-defined probability tolerance on typed verdicts rather than a fuzzy match over free text — but the recorded-inputs rule stands.

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

## 4. The judgment layer: Jev and the grill-me bank

The [§2 boundary](#2-the-honest-boundary-what-a-machine-may-attest) left the judgment column human-only. This section automates a *disciplined portion* of it by adopting the **Jev deciding-leg architecture** — the segregation-of-duties design specified in the Inflect planning documents *"Jev — the deciding leg"* and its 10-step implementation roadmap (living designs dated 2026-09-21; nothing built at the time of writing) — lifted from its original altitude (tenant agent-proposals) to AVA's altitude (attestation assessments). Same machine, two altitudes; where this section states a rule without its argument, the argument lives in those documents.

### 4.1 The shape: a verdict, never a signature

Jev forms an independent view on each judgment item and returns **`CONCUR | ESCALATE | REFUSE | ABSTAIN`**, entering AVA's assessment as a **narrowing term** — never as a signature, never as an approval row. At AVA's altitude:

| Verdict | Effect on the assessment | Worst case if Jev is wrong |
|---|---|---|
| `ESCALATE` | the item goes to a human verifier | a human was asked who need not have been |
| `REFUSE` | blocks the attestation pending a human override with a written reason | a good attestation is delayed |
| `ABSTAIN` | no term — humans decide as if Jev did not exist. **Every no-evidence path (timeout, outage, unparseable output) is `ABSTAIN`, never `CONCUR`** | nothing |
| `CONCUR` | counts toward the judgment-dimension pass — only at the top ladder rung, under the eligibility floor | **an attestation issues on machine judgment alone** |

The asymmetry is what makes the layer shippable: **friction-adding verdicts are free from day one; the friction-removing verdict is earned.** For most of its life the judgment layer can only make attestation *more* conservative.

### 4.2 Grill-me: the doctrine, elicited — not a settings page

Jev decides from a **signed assessment doctrine** — the written answer to *"how do we decide whether evidence satisfies dimension N at tier T?"* — elicited **grill-me style** from the humans whose judgment it will imitate (accredited verifiers and the foundation's expert panel), because asking "what is your assessment appetite?" produces platitudes that predict nothing. The four elicitation moves, per the Jev design:

1. **Replay** — real past assessment decisions (grants *and* refusals), outcome hidden; record the call.
2. **The inconsistency probe** — the question that is the whole value of the exercise: *you refused this deployment and attested a near-identical one — which was wrong, or what distinguishes them?* The answer is a candidate principle, arriving with its own worked cases attached.
3. **Boundary construction** — perturb **one** evidence dimension of an attested case until the assessor flips; record where. A principle with a located boundary is testable; one without is a mood.
4. **Refuse the untestable** — a principle enters the doctrine only with at least one worked case it correctly decides, enforced at the write seam, so an untestable doctrine cannot exist rather than merely being discouraged.

This is the **user-facing, constantly reviewed question set**: replay/probe/boundary items are drawn from live assessment history, every real incident spawns new probes, and doctrine versions are append-only, **human-signed**, diffable, and **pinned onto every verdict** (three-state pin discipline: predates-pinning / no-doctrine-in-force / the-version-that-governed). "Trainable judgment" therefore means something specific and governed: **the doctrine grows only through grilled elicitation and human signature — never through silent model drift.**

### 4.3 Calibration, the ladder, and the blind-hold

Authority is earned along the Jev mode ladder — `DISABLED → SHADOW → ADVISORY → NARROWING → DECIDING` (one-rung raises, an implemented-ceiling in code, dwell owed in the rung being left, narrowing always free) — with an instrument at every stage:

- **SHADOW** — Jev judges every assessment invisibly, accumulating a live calibration corpus before any of it counts.
- **The calibration gate** — Jev runs cold against a **held-out partition** of human assessment decisions (persisted, stratified, write-once, never used in elicitation). The report gives **false-concur** (Jev concurred, the human refused — the expensive error, and the only one that gates) and **false-escalate** separately, **against the base rate, never as accuracy** — on a corpus where most assessments pass, an always-concur judge scores high while being worth exactly nothing, and the single most important test in the Jev roadmap is that such a stub *fails* this gate. The gate also runs the **adversarial corpus**: the assessed deployment's self-descriptions rewritten to be maximally persuasive and instruction-shaped must not move the verdict distribution — evidence is data, never argument, *measured* rather than asserted.
- **ADVISORY + blind-hold** — verdicts become visible to human verifiers, which creates the new failure mode: humans rubber-stamping Jev. A **write-once, keyed blind-hold** withholds the verdict on a fraction of items until the human has decided; agreement between held and unheld arms is the measured proof that the second leg is real. ADVISORY is the evidence window every later promotion must cite.
- **NARROWING → DECIDING** — `ESCALATE`/`REFUSE` become load-bearing; then, only behind the full widen gate (fresh passing calibration · doctrine within its review cadence · a blind-hold result from ADVISORY · dwell served · **the judge not sharing a model with anything that produced the evidence under assessment**, checked on `actualModel`, because a silent upstream model swap is how two legs become one), `CONCUR` may carry judgment-dimension sign-off. **Standing recalibration auto-demotes** on a floor breach — narrowing needs no gate, which is why the ladder was built that way.

Class-J policy in [§2](#2-the-honest-boundary-what-a-machine-may-attest) reads directly off this ladder: a class-J attestation requires the judgment layer at its top rung for that assessment class, stays **capped at tier 2**, and tier 3 remains human-co-attested — the four-eyes analog a machine must never collapse.

### 4.4 Evaluator backends: where the Jev *model* fits

The deciding leg is deliberately backend-agnostic: a provider factory (stub / local / hosted arms, the residency short-circuit placed physically before the switch, fail-closed to `ABSTAIN`). The recommended production arm is [TypeSafe AI's **Jev**](https://en.wikipedia.org/wiki/Jev_(AI_model)) decision model (early access since 15 Sep 2026): not an LLM but a "System One" model returning **typed values with probability estimates and confidence scores**, built for software consumption ([TechCrunch](https://techcrunch.com/2026/09/18/a-new-kind-of-ai-model-from-a-chatgpt-inventor-is-thrilling-developers/), [Tom's Hardware](https://www.tomshardware.com/tech-industry/artificial-intelligence/typesafe-ais-jev-offers-an-alternative-to-llms-that-claims-to-be-193x-faster-and-445x-cheaper-system-one-type-model-is-bespoke-for-probabilistic-decision-making)). The shape matches the verdict vocabulary natively: typed verdicts sign cleanly into the execution transcript; ε becomes a probability tolerance instead of prose similarity; confidence-below-floor maps mechanically to `ESCALATE`; and the vendor-claimed 40–200× speed / 40–400× cost advantage makes deep grilling and standing recalibration economical. A decision model also **emits no rationale** — which is a feature here: the decision is typed and auditable, the explanation is the doctrine principle's own fixed, versioned text, and nothing generative sits in the trust path. Caveats stand: proprietary and one week into early access — the judge is a **pluggable, pinned component** (`judgeModelRef` bound into the accreditation ref `H(operatorId, pipelineImageDigest, rulesetHash, doctrineVersion, judgeModelRef)`), with a dual-judge fallback arm and the ladder pricing the uncertainty until a track record exists. **No silent judge update can ever grade an attestation.**

### 4.5 One architecture, two altitudes

The same Jev machinery serves twice, and the layers compound:

| | Inflect's Jev leg (planned) | AVA's judgment layer |
|---|---|---|
| Item judged | a tenant `AgentProposal` | a judgment item in an attestation assessment |
| Doctrine signed by | the tenant's operator | accredited verifiers / foundation panel |
| Grill-me corpus | the tenant's own decided proposal queue | the ecosystem's assessment history |
| `CONCUR` at top rung | auto-approves an eligible proposal | judgment-dimension sign-off for class-J, tier ≤2 |
| Never collapses | four-eyes proposals | tier-3 human co-attestation |

An Inflect tenant that has climbed its own Jev ladder produces, as a side effect, exactly the doctrine-adherence and human-oversight evidence AVA's dimension-2/3 assessment wants to see — the two ladders reinforce each other.

## 5. Accountability: the agent has an operator, and the agent is itself attested

Software cannot bear liability, and the IMDA framework's second dimension applies to the verifier too:

- **The operator is the accountable entity.** A legal person (an AI-testing firm — the entity AI TAP would accredit in the real world) operates AVA; the on-chain accreditation names operator + code version, and revocation reaches both.
- **AVA eats the dogfood.** AVA is an agent: it is registered (ERC-8004), carries its own PoCA attestation — bootstrapped by a *human* accredited verifier to break the chicken-and-egg — runs under kill-switch semantics, and emits the same receipts it demands of others. When operated against an Inflect tenant, it is a `RegisteredAgent` like any other, subject to the full gate chain.

## 6. Inflect integration deltas

The [integration plan](08-inflect-integration.md) barely changes — AVA slots into seams already built:

- **Input:** AVA consumes the step-7 evidence bundle via the `poca-bundle` export API; nothing new to build on the deployer side.
- **Receipts:** AVA's execution transcript posts to the existing `agent-receipts` endpoint (`src/lib/mcp/receipt-verification.ts` verifies Ed25519 today) — the tenant sees the assessment happen step-by-step in its own evidence timeline.
- **Verdict consumption:** identical — an AVA attestation is verified by the same four reads; gate 6 only additionally reads the accreditation scheme to apply class policy (M ⇒ tier-1 cap; tiers 2–3 require the `refUID`-linked H co-attestation).
- **Roadmap placement:** extends [step 9](08-inflect-integration.md#step-9--verifier-portal--eip-712-delegated-attestation-inflect--poca) (the portal's assessment form becomes AVA's judgment-dimension companion) and [step 10](08-inflect-integration.md#step-10--continuous-assurance--outbound-zk-pilot-inflect--poca) (surveillance addenda are the continuous-assurance feed).
- **Shared Jev machinery:** Inflect's planned Jev deciding leg (design + 10-step implementation roadmap, 2026-09-21) and AVA's judgment layer are one architecture at two altitudes ([§4.5](#45-one-architecture-two-altitudes)) — doctrine store, ladder, calibration gate, and blind-hold are built once and pointed twice, and a tenant's Jev-ladder progress doubles as doctrine-adherence evidence in its agents' PoCA bundles.

## 7. Threat-model deltas

| Threat | Answer |
|---|---|
| **Goodhart / benchmark gaming** — agents tuned to pass the public ruleset | Hold-out suites (private per epoch, published after rotation); ruleset rotation; class M capped at tier 1; human sampling audits catch teach-to-the-test artifacts |
| **TEE compromise** | Defense in depth: reproducibility (Level 0) and receipts (Level 1) survive a broken enclave; a quote is one signal, never the only one |
| **Ruleset capture** — whoever writes the rules owns the registry | Foundation governance with versioned public releases, diffs, and timelock; accreditation binds ruleset hash, so a captured rule change is a *visible new version*, revocable independently |
| **LLM-judge nondeterminism** | Judge outputs are signed inputs, not proven computation; ε-band re-execution; deterministic metrics preferred; disputes escalate to human review |
| **Operator suppression / cherry-picking** | Transparency log + deployer submission receipts + sampling audits (§3.5) |
| **AVA availability** | An outage delays new assessments only; existing attestations, expiries, and revocations live on-chain and are unaffected |
| **Version sprawl** | One active accredited version at a time per operator (foundation policy); old versions' grants expire naturally |
| **Judge injection** — the assessed deployment's self-descriptions crafted to manipulate verdicts | Evidence enters Jev strictly in the data position (provenance allowlist, no fallthrough); the calibration gate's **adversarial corpus proves** persuasive/instruction-shaped rationales do not move the verdict distribution, with a planted instruction-following stub failing the test to prove it discriminates |
| **Doctrine overfitting** — deployments tuned to published principles and worked cases | The **held-out partition** (persisted, stratified, write-once) is never elicited from and alone gates promotion; incident-driven probes keep the doctrine ahead of teach-to-the-test; blind-hold + human sampling catch memorized compliance |
| **Doctrine poisoning / panel capture** — malicious principles or biased review | A principle cannot be persisted without a worked case it correctly decides (write-seam refusal); versions are human-signed, append-only, diffable; n-of-m panel, foundation-governed and rotated, with timelocked releases |
| **Judge miscalibration or drift** | False-concur-vs-base-rate gate (an always-concur judge must fail it); public calibration dashboard with alarms; **standing recalibration with automatic demotion** down the ladder — narrowing needs no gate |
| **Judge vendor risk** — proprietary early-access evaluator model | Backend-agnostic provider factory, fail-closed to `ABSTAIN`; pinned `judgeModelRef` in the accreditation ref; dual-judge fallback arm; class-J tier caps price the uncertainty until a track record exists |

## 7. Phasing

| Phase | What ships | Trust change |
|---|---|---|
| **AVA-0 — CI mode** | The pipeline runs as *pre-assessment* gating human attestation: verifiers only sign bundles that passed machine checks; transcript included in the bundle | None — humans still sign everything; immediate quality floor |
| **AVA-1 — class M** | AVA accredited (`PoCA-AVA-v1`), issues tier-1 machine attestations + surveillance addenda; transparency log live; reproducibility + receipts (Levels 0–1) | New, bounded: machine-only claims, lowest tier, fully re-executable |
| **AVA-J — the judgment layer** | The Jev deciding leg at AVA altitude ([§4](#4-the-judgment-layer-jev-and-the-grill-me-bank)): grill-me doctrine elicitation, SHADOW corpus, the calibration gate (false-concur vs base rate), ADVISORY + blind-hold, then class-J attestations for tier ≤2 | Judgment becomes calibrated, escalating, and auditable — its authority earned rung by rung, never silently widened |
| **AVA-2 — TEE** | Enclave execution, quotes in bundles; optional quote-checking resolver variant | Code identity becomes cryptographic, not procedural |
| **AVA-3 — co-attestation & zk** | Tier-3 co-attestation (J+H / M+H) end-to-end; zkVM proofs for the deterministic subset | Judgment stays human-anchored, everything mechanical becomes provable |

The deliberately boring conclusion: AVA never replaces the accreditation layer — it makes one verifier *radically more inspectable* than any human firm can be, and it is held to every standard it enforces.
