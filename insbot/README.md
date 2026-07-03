# Insurance Assistant Bot (Bulgaria)

A chat bot that quotes and compares Bulgarian motor insurance (Гражданска отговорност /
MTPL now, Каско / Casco later), stores policies, and reminds users before expiry.

This directory is the backend for that project. See the full plan in
`/.claude/plans/i-want-to-build-cosmic-canyon.md`.

## What works today (Stage 1)

- **Rating engine** — prices any vehicle against any number of carrier tariffs using one
  model: `premium = base × ∏(factors) + Σ(loadings)`. Verified to the stotinka by tests.
- **Channel-agnostic conversation flow** — collects vehicle + owner data and returns
  ranked MTPL quotes. Reused verbatim by any channel adapter.
- **Telegram adapter + FastAPI webhook** — Stage-0 hosting skeleton.
- **Expiry reminders** — one daily job, sends at 30/14/1 days, can't double-send.
- **Two demo carriers** seeded with illustrative tariffs (NOT real prices).

## Quick start

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

# See it work with zero setup (in-memory DB, scripted chat):
PYTHONPATH=. python -m insbot.demo

# Run the tests (rating golden samples, conversation flow, reminder dedupe):
python -m pytest -q
```

## Run the Telegram bot (Stage 0)

1. Create a bot with **@BotFather**, get the token.
2. `export INSBOT_TELEGRAM_TOKEN=123:abc`
3. `uvicorn insbot.app.main:app --host 0.0.0.0 --port 8000`
4. Expose port 8000 over **HTTPS** (a tunnel for dev; a real host like Fly.io/Railway for prod).
5. Register the webhook:
   `curl "https://api.telegram.org/bot$INSBOT_TELEGRAM_TOKEN/setWebhook?url=https://YOURHOST/webhook/telegram"`
6. Message your bot: type `старт`.

## Layout

```
insbot/
  app/         FastAPI app, config, DB engine/session
  models/      SQLAlchemy 2.0 models (rate_component.py is the canonical core)
  rating/      schemas + engine (compute_quotes) + factor definitions
  conversation/ channel-agnostic state machine + BG copy
  channels/    base contract + telegram adapter (viber later)
  reminders/   daily expiry-reminder job
  vehicle_sources/ pluggable data source (manual now; eisoukr stub for later)
  ingestion/   rate-table upload pipeline (Stage 2 — to build)
  mappings/    per-carrier YAML (data, not code — Stage 2)
  seed.py      demo carriers + golden samples
  demo.py      runnable end-to-end demo
tests/
```

## Important caveats (read before going live)

- **Demo tariffs are fake.** Replace them with real carrier data via the ingestion
  pipeline, and gate every table behind a golden-sample check (recompute known real
  quotes; refuse to activate if off by >0.01 BGN).
- **Plate → vehicle specs is not publicly available in Bulgaria.** v1 collects vehicle
  data manually. Auto-fill needs Guarantee Fund **ЕИСОУКР** access, available only to
  licensed insurers/intermediaries — drop it into `vehicle_sources/` when you have it.
- **Viber bots are commercial-only (~€100/mo).** This backend is channel-agnostic and
  runs on free Telegram first; add a Viber adapter later without touching the core.
- **GDPR:** never store a raw ЕГН (only a salted hash), minimize personal data, and keep a
  lawful basis for any ЕИСОУКР data. Confirm your КФН obligations for digital distribution.

## Roadmap

- **Stage 2:** rate-table ingestion (xlsx/csv → canonical rows via per-carrier YAML) +
  golden-sample validation gate; onboard real carriers.
- **Stage 3:** persist chosen policies + wire the reminder job to real users; Telegram UX.
- **Stage 4:** Casco, PDF ingestion, OCR of талон, ЕИСОУКР auto-fill, Viber, Postgres.
