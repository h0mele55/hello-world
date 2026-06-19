# AI Kit (#31–#36) — open-model AI: local-first, swappable to production

The decision (from the model research): there is **no production-worthy agriculture nano-LLM**
with clean open weights. So the architecture is a **clean-licensed small general model run
locally for dev → hosted API in production, behind ONE provider interface, made agricultural
via RAG**, with a separate **vision** model for photos. Continues the kit series; runs in the
agri-saas session (re-paste `MEMORY-IMPORT.md` if fresh). Order 31 → 36. Paste
`MEMORY-EXPORT.md` at each checkpoint.

Model/licence decisions baked in:
- Local dev LLM: **Qwen3-1.7B/4B (Apache-2.0)** via **Ollama**; benchmark **Granite-4.0-1B
  (Apache-2.0)** for tool/JSON-heavy paths. Optional **Dhenu2-1B** (Llama-licensed, India-
  centric) only as an agri baseline to A/B — never the production default.
- Production: env-swap to **OpenRouter (already wired) / Groq**; **Anthropic Claude** via its
  NATIVE adapter (not the OpenAI shim) for load-bearing reasoning.
- Vision: **CropNet / MobileNetV2 (Apache/MIT)** + **Claude vision** fallback.
- AVOID for commercial: AgriParam/Param-1 weights (non-commercial), Qwen2.5-3B (non-commercial),
  GlobalG.A.P. standard text (copyrighted — reference, don't ingest). OK to ingest: KCC (GODL),
  FAIR-Forward/Digital Green QA, EU 2018/848 + USDA 7 CFR 205 (free/public-domain).

---

### #31 — Provider interface + local Ollama/Qwen3 wiring

```
Goal: one swappable AI provider; local dev runs a clean-licensed small model with zero API cost.

Build:
- Generalize the existing src/app-layer/ai/risk-assessment/openrouter-provider.ts into a thin
  AiProvider interface (src/app-layer/ai/provider.ts): complete({messages, schema?, tools?,
  stream?}) → typed result. Keep all AI call sites depending only on this interface.
- One OpenAI-compatible implementation (openai-compatible-provider.ts) using the `openai` SDK
  that serves Ollama + OpenRouter + Groq + Together by config (baseURL/apiKey/model). The
  current OpenRouter provider becomes one config of this.
- Env-driven selection (ai/index.ts): AI_BACKEND, AI_BASE_URL, AI_API_KEY, AI_MODEL. Dev defaults:
  http://localhost:11434/v1 + qwen3:1.7b (apiKey "ollama"). Document `ollama pull qwen3:1.7b`
  + a docker-compose `ollama` service for the dev stack.
- Structured output: define schemas with Zod and convert via zodToJsonSchema → response_format
  json_schema; tools via the `tools` param. Add a tiny capability map (which models honor JSON
  schema / tools) so the provider degrades gracefully (validate+repair JSON when unsupported).
- A health check + model-availability probe; clear error if Ollama isn't running.

Reuse: existing openrouter-provider.ts, the `openai` SDK, Zod, docker-compose dev stack.
Done: same call site works against local Ollama (qwen3:1.7b) and OpenRouter by flipping env;
structured-output + tool calls round-trip; unit tests with a mocked client; tsc 0. Commit
feat/ai-provider, push, MEMORY EXPORT.
```

### #32 — Agriculture RAG pipeline + open-corpus ingestion

```
Goal: make the general model agricultural with retrieval — the proven pattern (RAG > fine-tune
for facts).

Build:
- Vector store on the existing Postgres: enable pgvector (migration: CREATE EXTENSION vector;
  hand-authored like the postgis one), add a KnowledgeChunk table (tenantId nullable for GLOBAL
  corpus vs tenant docs; RLS catalog-variant policy so global rows are world-readable, tenant rows
  isolated). Embeddings via an OpenAI-compatible embeddings endpoint (Ollama nomic-embed-text /
  bge-small locally; hosted in prod) behind the same provider env.
- Ingestion scripts (scripts/rag/) with LICENSE GATING — only ingest commercially-safe corpora:
  KCC farmer Q&A (GODL), FAIR-Forward/Digital Green QA, EU Reg 2018/848 (EUR-Lex) + USDA 7 CFR 205
  (public domain). Do NOT ingest GlobalG.A.P. standard text (copyrighted) — reference by citation
  only. Record provenance + license per source in THIRD_PARTY_NOTICES.md.
- Also index the tenant's OWN data as retrievable context (journal entries, SOPs/knowledge base,
  crop plans, product labels) — tenant-scoped, RLS-enforced, never cross-tenant.
- A retrieve() helper (hybrid: vector + keyword) returning cited chunks; a buildContext() that
  assembles a grounded prompt with inline source citations; answers must cite or say "not in my
  sources".

Reuse: Postgres + the pgvector pattern mirroring geo.ts, BullMQ for batch embedding jobs,
knowledge-base module, RLS guardrail.
Done: ask a spray/agronomy question and get a cited answer grounded in ingested corpora; tenant
docs retrievable + isolated (RLS test); license provenance recorded; tsc 0; rls-coverage green.
Commit feat/ai-rag, push, MEMORY EXPORT.
```

### #33 — Production API + native Claude adapter + streaming

```
Goal: production inference behind the same interface, with Claude for load-bearing reasoning.

Build:
- Production config of the OpenAI-compatible provider: OpenRouter as default/failover, Groq as the
  cheap/fast backend for high-volume tasks (classification, extraction, copilot explanations).
- A dedicated NATIVE Claude adapter (claude-provider.ts) using the Anthropic Messages API (NOT the
  OpenAI shim — preserves prompt caching + extended thinking + proper tool use). Selected via
  AI_BACKEND=claude. Tier policy: Haiku for cheap/high-volume, escalate to Sonnet/Opus for
  dosage/regulatory/long-horizon reasoning.
- Streaming responses end-to-end (SSE) to the UI for the agronomy copilot; cancellation on
  unmount; graceful fallback to non-streaming.
- A routing policy module: task → model tier (e.g., extraction→Groq small; copilot→mid; dosage/
  regulatory→Claude Sonnet), with per-task max-tokens + timeout + retry/failover.

Reuse: AiProvider interface from #31, @anthropic-ai/sdk, existing SSE/streaming patterns,
entitlements for tier gating.
Done: prod env serves answers via OpenRouter/Groq; AI_BACKEND=claude routes through the native
adapter with streaming; routing policy picks the right tier; integration tests with mocked
backends; tsc 0. Commit feat/ai-prod-routing, push, MEMORY EXPORT.
```

### #34 — Vision pest/disease ID path

```
Goal: photo → likely pest/disease + recommendation, wired into the journal photo flow.

Build:
- A vision inference path behind a VisionProvider interface with two backends: (a) a small
  on-device/edge classifier — CropNet (Apache-2.0 TFLite) or a MobileNetV2 PlantVillage model
  (Apache/MIT) served via an ONNX/TFLite runtime or a tiny sidecar; (b) Claude vision (multimodal)
  as the cloud fallback / higher-quality path.
- Trigger: when an image is uploaded to a LogEntry (reuse the existing FileRecord pipeline), run
  classification ASYNC via a BullMQ job; write result into LogEntry.attributesJson
  {identifiedPest, confidence, recommendation, modelVersion}.
- UI: an in-page suggestion card showing label + CONFIDENCE + a mandatory "verify with an
  agronomist — not a diagnosis" disclaimer; never auto-apply a treatment.
- Honesty: surface field-vs-lab accuracy caveats; gate low-confidence results; log the model +
  version for auditability. Pair pest-ID with the existing AgroSignal copilot (#18/#25) for the
  textual explanation.

Reuse: FileRecord upload pipeline, BullMQ jobs, AgroSignal/copilot, Claude vision via #33 adapter.
Done: uploading a leaf photo yields an async classification + recommendation with confidence +
disclaimer; on-device and Claude backends both work; result stored + audited; tsc 0. Commit
feat/ai-vision, push, MEMORY EXPORT.
```

### #35 — Agronomy evals + safety guardrails

```
Goal: prove the AI is good enough, and make it safe where stakes are real (dosage, chemicals,
regulatory).

Build:
- An eval harness (scripts/ai/eval/ + tests): a golden set of agronomy Q&A (AgriEval-style MCQ +
  open-ended, plus your own domain cases for spray windows, dosing, certification), scored
  automatically (exact/contains + an LLM-judge with a rubric). Run in CI as a non-blocking report;
  track regressions across model/prompt changes.
- Safety policy: a "verify with an agronomist" disclaimer on all advisory output; HARD escalation —
  dosage/chemical-mixing/regulatory questions must route to the strongest tier (Claude Sonnet/Opus)
  AND require citations, or refuse with a safe fallback ("consult your agronomist / product label").
- Refusal + uncertainty: calibrated "I don't know / not in my sources" when RAG retrieves nothing
  relevant; never fabricate dosages or REI/PHI numbers — pull those from structured product data,
  not the LLM.
- Prompt-injection defense for any user/RAG-sourced text (treat retrieved docs + tenant input as
  untrusted; system-prompt hardening; output schema validation).

Reuse: provider routing (#33), RAG citations (#32), structured product data (Item.attributesJson),
existing test/CI infra.
Done: eval report runs in CI with a baseline score; dosage/regulatory queries escalate + cite or
refuse; injection tests pass; no fabricated dosage numbers (test); tsc 0. Commit feat/ai-evals-safety,
push, MEMORY EXPORT.
```

### #36 — Cost, PII, rate-limit & observability guardrails

```
Goal: keep AI cheap, private, abuse-resistant, and observable in production.

Build:
- Token/cost budgets per tenant + plan via the existing entitlements (assertWithinLimit re-keyed to
  AI tokens/month); soft-warn + hard-stop with a clear upgrade path; per-request max-tokens caps.
- PII redaction before any EXTERNAL call: strip/where-needed encrypt user identifiers, contract
  terms, precise coordinates from prompts sent to third-party APIs; prefer local model for
  sensitive content; document the data-flow per backend (local vs hosted).
- Rate limiting on AI endpoints (reuse the Upstash limiter), with a separate, tighter AI tier.
- Observability: OTel spans on every AI call (model, tokens-in/out, cost, latency, cache hit,
  task) reusing src/lib/observability/instrumentation.ts; an immutable audit-log entry for every
  AI-generated piece of advice (what model, prompt hash, citations) so advice is traceable.
- Caching: response/embedding cache (Redis) keyed on normalized prompt+context to cut cost/latency.
- Optional: wire the Dhenu2-1B local baseline into the eval harness (#35) to A/B agri-tuned vs
  general+RAG, documenting the licence caveat.

Reuse: entitlements, field-encryption manifest, Upstash rate-limiter, OTel, AuditLog, Redis.
Done: per-tenant AI budgets enforce; PII redacted before hosted calls (test); AI rate-limit active;
spans + audit entries appear for each call; cache cuts repeat-call latency; tsc 0. Commit
feat/ai-guardrails, push, FINAL MEMORY EXPORT.
```
