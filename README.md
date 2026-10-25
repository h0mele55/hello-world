# hello-world → Audit Report Anchoring

A prototype that anchors audit-report PDFs on a public testnet, links each PDF
to the block that recorded it, points every reissued version to the latest, and
lets outside parties check a copy in their own browser without uploading it.

**Status:** Phases 0 and 1 of 7 are done: a Next.js app built on Inflect's UI
primitives, and the registry contract with its chain adapter, tested on a local
Anvil chain. It is not deployed to Sepolia yet, and nothing touches a PDF yet.
Testnet anchors, once they exist, are prototype evidence, not legal evidence.

- Plan, phases and the prompt for each phase: [`docs/ROADMAP.md`](docs/ROADMAP.md)
- Design decisions: [`docs/adr/`](docs/adr/)
- Rules for contributors and coding agents: [`CLAUDE.md`](CLAUDE.md)

```bash
npm ci
npm run dev        # http://localhost:3000, and /kitchen-sink for the UI kit
npm test           # unit tests
npm run build && npm run test:e2e
npm run test:integration   # chain adapter on Anvil; needs Foundry
```

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
