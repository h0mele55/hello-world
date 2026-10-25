# Rotating the issuer key

The issuer key signs every anchor, copy and revocation in the firm's name. A
rotation registers a new key, lets the old one finish what it started, switches
the worker over, and retires the old key. **Everything the old key anchored
keeps verifying**, under the firm's name, and the new key continues the same
families.

This is rehearsed on Anvil by `tests/anchoring/worker.test.ts` › "a new key
continues the firm’s families, the old key writes nothing more, and everything
it anchored still verifies".

## When

- On a schedule the firm sets (for example yearly).
- When the key moves to KMS (#62).
- **At once**, if the key may be stolen: see [If the key may be stolen](#if-the-key-may-be-stolen).

## What you need

- The registry owner, able to execute two transactions. Today that is the
  deployer key; after [ownership-to-safe.md](ownership-to-safe.md) it is the
  Safe's signers.
- An approver signed in to the console.
- Access to the worker's and the app's environment.

## Steps

1. **Make the new key** where the worker will hold it, never on the app
   server. Note its address. It must not be the owner's key.
2. **Fund it** with enough for the expected anchors (each anchor costs about
   the gas in `contracts/snapshots/`); the console warns below 0.02 ETH.
3. **The owner registers it.**

   ```sh
   npx tsx scripts/owner-call.ts sepolia add-issuer <new address>
   ```

   This checks the chain and the registry against `deployments/sepolia.json`,
   simulates the call from the owner, and prints the transaction. The owner
   executes it. Both keys can now write.
4. **Drain the old key.** An approver sets the firm's write mode to
   **DISABLED** in Settings.
   - A write not yet started fails with `MODE_NARROWED`, and nothing is sent.
     A version's anchor goes back to waiting for approval; a stamped copy waits
     for "Retry copy".
   - What the old key already sent is still settled by its worker, from chain
     state.

   Wait until the old key has nothing in flight:

   ```sql
   SELECT status, kind, count(*) FROM "ChainWrite"
   WHERE lower(issuer) = lower('<old address>') AND status IN ('INTENT', 'BROADCAST', 'INDETERMINATE')
   GROUP BY 1, 2;
   ```

   An INDETERMINATE write that does not settle holds the key: follow
   [stuck-writes.md](stuck-writes.md).
5. **Switch.** Stop the old worker. Set `ISSUER_PRIVATE_KEY` and
   `ISSUER_ADDRESS` to the new key for the worker, and `ISSUER_ADDRESS` for the
   app, then restart both. The worker refuses to start if the two disagree.
   `deployments/sepolia.json` keeps naming the key the registry was deployed
   with; the verifier names the firm by its org id, which does not change.
6. **Widen again**: DISABLED, then DRY_RUN, then LIVE.
   - An approver approves again the versions that went back to waiting, and
     presses "Retry copy" on versions whose copy failed `MODE_NARROWED`.
   - Signed reports the old key anchored get their certificate from the new
     worker; a certificate signs nothing.
7. **The owner retires the old key.**

   ```sh
   npx tsx scripts/owner-call.ts sepolia remove-issuer <old address>
   ```

   From then on the old key can write nothing: the registry refuses it with
   `NotIssuer`. Move whatever balance it still holds to the new key.
8. **Check.**
   - At `/verify`, verify a report the old key anchored (AUTHENTIC, under the
     firm's name) and one the new key anchored.
   - `/audit-log` is intact.

## If the key may be stolen

Do not wait for the drain: **retire the key first** (step 7, then steps 1–3
for the new one). A transaction the old key signed but that is mined after
that is refused by the registry. Then:

- Look for writes the journal did not make: run `npm run watch:registry` and
  read the registry watch on `/audit-log`, which lists every anchor and
  revocation by the firm's keys whose transaction no journal row holds.
- A stolen key could have asked to revoke records. Each request waits out the
  registry's delay, and the owner cancels it in that time
  ([stolen-issuer-key.md](stolen-issuer-key.md)), right after retiring the key
  or in the same Safe batch: retiring it does not undo what it asked. A revocation
  already in effect is terminal and its document cannot be anchored again:
  reissue each affected report as a new version (a new file), and tell its
  recipients.
- Record what you found and did in the incident log.

## Never

- Reuse the owner's key as an issuer key.
- Delete or edit the old key's `ChainWrite` rows to "clear" them.
- Retire the only active key before the new one is registered, unless the key
  is stolen: anchoring then stops until step 3.
