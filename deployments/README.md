# Deployments

One JSON file per network, written by `scripts/deploy-registry.ts` and read by
`src/lib/chain/networks.ts`.

| File | Status |
| --- | --- |
| `sepolia.json` | Not deployed yet. Waiting on funded keys ([#4](https://github.com/h0mele55/hello-world/issues/4)). |
| `base-sepolia.json`, `optimism-sepolia.json`, `arbitrum-sepolia.json` | The production candidates' testnets: deployable now, waiting on funded keys (#4). |
| `mainnet.json`, `base.json`, `optimism.json`, `arbitrum.json` | Production: refused by the deploy script until the owner chooses the chain ([#63](https://github.com/h0mele55/hello-world/issues/63), `docs/decision-production-chain.md`). |

A file records the chain id, the registry address, the deploy transaction and
block, the owner, the registered issuer, and `runtimeBytecodeHash`. Code refuses
a deployment whose bytecode hash is not the current build's
(`DEPLOYMENT_STALE`), and every write re-checks the chain id and the code at the
address before it is sent.

The script never overwrites an existing file: a second registry would split
every report family's history in two. To rehearse it, run it against Anvil with
`local`; `deployments/local.json` is git-ignored.

The app and the worker use the deployment named by `ANCHOR_NETWORK`. CI
deploys a fresh registry to Anvil with `local` for the end-to-end tests.
