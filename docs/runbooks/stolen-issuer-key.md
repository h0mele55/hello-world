# Revocations the firm did not ask for

An issuer key can only **ask** the registry to withdraw a record. The
revocation takes effect `revocationDelay` seconds later (24 hours unless the
deployment record says otherwise: `revocationDelaySeconds` in
`deployments/<network>.json`). **Until then the registry's owner can cancel
it.** Once it is in effect, nobody can: the record reads revoked for good, and
the report has to be reissued as a new file.

So a stolen issuer key cannot withdraw the firm's reports at once. The owner has
the delay to notice and to cancel. This runbook is what to do in that delay.

It is rehearsed on Anvil by `tests/integration/owner-call.test.ts` › "cancels a
pending revocation before its time, and refuses one that is absent or already
in effect", and the console's side by `tests/anchoring/worker.test.ts` › "marks
a revocation the registry’s owner cancelled as CANCELLED, keeps the version,
and lets the firm ask again".

## When

- The issuer key may be stolen, or the worker's host was compromised.
- A client or a recipient says the verifier calls a report **being withdrawn**
  (REVOCATION_PENDING), and nobody at the firm asked for that.
- The worker logged `the record carries a revocation the console did not ask
  for`.

Nothing watches the chain for these requests yet (#93). Until it does, someone
has to look.

## What you need

- The registry owner, able to execute transactions quickly. Today that is the
  deployer key; after [ownership-to-safe.md](ownership-to-safe.md) it is the
  Safe's signers. **Reach them first**: the delay is the whole margin.
- The network's RPC endpoint (`SEPOLIA_RPC_URL`, …) and Foundry's `cast`.
- An approver or admin signed in to the console.

## Steps

1. **Retire the stolen key** ([key-rotation.md](key-rotation.md), "If the key
   may be stolen"): one transaction, and the key can ask for nothing more.
   Retiring it does **not** undo what it already asked; only step 4 does. In a
   Safe, put the retirement and the cancellations in one batch.

2. **List the revocations asked for on chain**, from the registry's deploy
   block (`deployBlock` in the deployment record):

   ```sh
   cast logs --rpc-url "$SEPOLIA_RPC_URL" --address <registry> --from-block <deployBlock> \
     'RevocationRequested(bytes32 indexed recordId, uint8 reasonCode, uint40 effectiveAt, address issuer)'
   ```

   Each log names the record, the reason's code, the time it takes effect and
   the key that asked.

3. **Tell the firm's from the rest.** The firm's own requests are in the
   console: each one is a revocation an admin asked for and an approver
   approved, and `/audit-log` holds a `revocation.scheduled` event with its
   record id and time. Anything else is not the firm's. In particular, the
   console only ever revokes an **original**: a request for a stamped copy's
   record is never the firm's.

4. **Have the owner cancel each one that is not the firm's**, those closest to
   their time first:

   ```sh
   npx tsx scripts/owner-call.ts sepolia cancel-revocation <recordId>
   ```

   This checks the chain and the registry, refuses a record with no revocation
   or one already in effect, warns when less than 15 minutes are left, simulates
   the call from the owner, and prints the transaction. The owner executes it:
   in the Safe, several cancellations can go in one batch (Transaction Builder,
   custom data). While the owner is a single key on a testnet rehearsal,
   `--send` with `OWNER_PRIVATE_KEY` sends it.

   A cancellation mined after the revocation's time reverts, and the record
   then reads revoked for good: see [If one took effect](#if-one-took-effect).

5. **Check.** List the cancellations too, with the event
   `'RevocationCancelled(bytes32 indexed recordId, uint8 reasonCode, address by)'`:
   every request that is not the firm's must have one after it. Drop each affected report
   into `/verify`: it must read authentic again once the cancellation is in a
   finalized block.

6. Record what you found and did in the incident log.

## If the owner cancels a revocation the firm did ask for

The console shows it **Cancelled by the owner**, the version stands, and
`/audit-log` holds `revocation.cancelled` with the cancelling transaction. An
admin can ask again, and an approver who is someone else approves again; the
delay starts over. If the owner did not mean to cancel it, treat the owner's key
as compromised too ([ownership-to-safe.md](ownership-to-safe.md)).

## If one took effect

It is terminal: the record reads revoked for good, and a document hash cannot
be anchored again. Reissue the report as a new version (a new file), have it
approved and anchored as usual, and tell its recipients. The console does not
record a revocation it never asked for, so note it in the incident log.

## Never

- Cancel a revocation the firm asked for in order to "test" the owner's path.
  Rehearse on Anvil or a testnet registry.
- Wait for the drain of the old key before retiring it and cancelling: both are
  urgent, and the delay is the whole margin.
- Edit `Revocation` or `ChainWrite` rows to match what you did. The worker reads
  the outcome from the chain: a cancelled request becomes CANCELLED by itself.
