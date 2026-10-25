# An RPC endpoint is down, slow or disagrees

Two parts of the system read the chain through RPC endpoints:

- **The worker** reads and sends through one endpoint (`SEPOLIA_RPC_URL`).
- **The verifier** reads through two independent endpoints, and refuses to
  give a verdict when they disagree or one cannot be reached (rule 7).
  - `/verify` takes them from `VERIFY_RPC_URL_1` and `VERIFY_RPC_URL_2`.
  - `dist/verifier.html` and the CLI have them built in.

## The worker's endpoint

**What you see.** The worker logs
`"pass failed; trying again after the interval"` with an error name such as
`HttpRequestError`, and a count. After 20 failed passes in a row (about five
minutes) it exits 1, for its supervisor to restart it with fresh connections.
Run it under one that restarts it, for example a systemd unit with
`Restart=always` and `RestartSec=30`.

**What happens meanwhile.** Nothing is lost.
- Rows keep their state.
- A write that was being sent when the endpoint went away becomes
  INDETERMINATE and is settled from chain state once the chain can be read
  ([stuck-writes.md](stuck-writes.md)).
- New anchors wait.

**What to do.**
1. Check the provider's status page.
2. If the outage lasts, point `SEPOLIA_RPC_URL` at another provider and
   restart the worker. The worker checks the chain id and the registry's
   bytecode before every write, so a wrong endpoint is refused, not used.
3. Never resend a write by hand.

## The verifier's endpoints

**What visitors see.** "Cannot verify right now", with the reason: an endpoint
cannot be reached, is on another chain, or the two disagree. They get no
verdict, never a wrong one.

**What to do.**
1. Find which endpoint fails. Ask both for the finalized block, for example
   `cast block finalized --rpc-url <url>`, and compare.
2. Replace the failing one with another **independent** provider: never two
   URLs of one provider, and never a URL with a key in it, because every
   visitor receives these URLs.
3. Set `VERIFY_RPC_URL_1` / `VERIFY_RPC_URL_2` and restart the app.
4. Rebuild and republish the single-file verifier, whose endpoints are built
   in (`npm run build:verifier`, #85).

**Two endpoints that disagree** at the same finalized block means one is
lagging, forked or lying. Do not "fix" the disagreement by pointing both at
the one that gives the answer you expect. Replace the endpoint that differs
from the public explorer.
