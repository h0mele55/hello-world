# An RPC endpoint is down, slow or disagrees

Two parts of the system read the chain through RPC endpoints:

- **The worker** reads and sends through `SEPOLIA_RPC_URL`, and settles a row
  (FINAL, linked, failed, revoked, cancelled) only on what that endpoint and a
  second one, `SEPOLIA_RPC_URL_2` from another provider, both read at one
  finalized block (#92). It refuses to start without the second, or with one
  on the same host as the first.
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

## The worker's two endpoints disagree

**What you see.** A banner on every console page: "The worker's two RPC
endpoints have disagreed about the chain since …". The worker logs
`"the two RPC endpoints disagree; what depends on it waits until they agree"`
with what they disagree about (a finalized block, a receipt, a record), and
its pass line carries `"rpcDisagreed": true`.

**What happens meanwhile.** Nothing is settled on one endpoint's word.
- Every row whose settlement depends on the disputed read stays as it was:
  a BROADCAST anchor stays BROADCAST, a scheduled revocation stays SCHEDULED.
  Each pass reads both again.
- The worker still sends new writes through the first endpoint: what a write
  sends is checked by the registry itself, and simulated first. Only what the
  worker concludes from the chain needs two endpoints. A refusal before
  sending (a record that does not match, a simulation that reverts) rests on
  the first endpoint alone: it sends nothing and returns the approval, so a
  lying first endpoint can delay writes but never forge an outcome. If writes
  fail that way while the banner is up, give the approvals again once the
  endpoint is replaced.
- An endpoint that is merely behind is not a disagreement: the worker reads at
  the lower of the two finalized blocks and waits.

The banner clears after the first pass in which the two agree.

**What to do.**
1. Find which endpoint is wrong. Ask both, and a public explorer, for the
   same finalized block, for example `cast block <number> --rpc-url <url>`,
   and compare the hashes. For a record, `cast call <registry>
   'getRecord(bytes32)' <recordId> --block <number> --rpc-url <url>`.
2. Replace the endpoint that differs from the explorer with another
   independent provider, set `SEPOLIA_RPC_URL` or `SEPOLIA_RPC_URL_2`, and
   restart the worker.
3. Never point both variables at the same provider to make the banner go
   away: the worker refuses the same host, and two URLs of one provider are
   one witness.
4. If the first endpoint was the wrong one, treat what it told the worker as
   suspect: run the registry watch (`npm run watch:registry`) and look for
   rows that went INDETERMINATE while it was in use
   ([stuck-writes.md](stuck-writes.md)).

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
4. Republish the single-file verifier, whose endpoints are built in: set the
   repository variables `VERIFY_RPC_URL_1` / `VERIFY_RPC_URL_2` and run the
   "Publish the single-file verifier" workflow (#85, `docs/operations.md`).
   Copies recipients already keep still read the old endpoints.

**Two endpoints that disagree** at the same finalized block means one is
lagging, forked or lying. Do not "fix" the disagreement by pointing both at
the one that gives the answer you expect. Replace the endpoint that differs
from the public explorer.
