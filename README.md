# hello-world → Audit Report Anchoring

A prototype that anchors audit-report PDFs on a public testnet, links each PDF
to the block that recorded it, points every reissued version to the latest, and
lets outside parties check a copy in their own browser without uploading it.

**Status:** the prototype (Phases 0–4) and the issuer console (Phase 5) are
done and tested on a local Anvil chain; Phase 6 (production hardening) is under
way. A preparer uploads an audit report and confirms its opinion; another person
approves; a worker anchors it, issues a stamped distribution copy (sealed with
the firm's electronic seal where configured), and timestamps its manifest on
Bitcoin; anyone can check a copy at `/verify` or with the single-file verifier,
without uploading it. Production is Arbitrum One
([`docs/decision-production-chain.md`](docs/decision-production-chain.md)); the
Sepolia deployment waits on funded keys (#4). Testnet anchors are prototype
evidence, not legal evidence.

- Plan, phases and the prompt for each phase: [`docs/ROADMAP.md`](docs/ROADMAP.md)
- Design decisions: [`docs/adr/`](docs/adr/)
- Rules for contributors and coding agents: [`CLAUDE.md`](CLAUDE.md)

```bash
npm ci
cp .env.example .env               # fill in the values it describes
set -a; . ./.env; set +a           # Prisma 7 reads the environment, not .env
docker compose up -d               # Postgres, with POSTGRES_PASSWORD from .env
npx prisma migrate deploy && npm run db:seed
npm run dev        # http://localhost:3000, and /kitchen-sink for the UI kit
npm test           # unit tests
npm run build && npm run test:e2e
npm run test:integration   # chain adapter on Anvil; needs Foundry
npm test -- --coverage     # with a coverage report in coverage/unit
```

What runs besides the app (the worker, the mailer, the nightly checks) is in
[`docs/operations.md`](docs/operations.md).

`vendor/inflect-ui/` is a pinned copy of components from
[inflect-compliance](https://github.com/rodnapamet/inflect-compliance), licensed
under BUSL-1.1 (see `vendor/inflect-ui/LICENSE`). Do not edit it; see
`CLAUDE.md`.

## Where this repo started

My First Git Repository
This is one of my first plays with git. So far i am a bit lagging in experience but i compensate with drive and zeal to learn.
I will make it happen. 
Oh yes !

Believe it or not, i am writing this 8 months after creating the master branch. Loads of changes happened since then, i think i was in UK at the time of the initial commit. And now, believe it or not, am in the 3M Sofia office, auditing financial statements. What a change, hey. Will see what the future holds.

Ta-Dah,
Eivo
