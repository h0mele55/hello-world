# A head of the audit log on chain is missing from it

Each night `npm run audit:check` writes the hash of the firm's latest audit
event to the registry, through the journal and the worker (#94). Every head on
chain that the registry's owner has not voided must still be the hash of an
event in the firm's audit log. A head is never removed from the chain, so
whoever owns the database cannot rewrite the log's past and its checks
together: the head written before the rewrite is still there.

When one is missing, the check fails with `ANCHORED_HEAD_MISSING`.

## When

- The check's error line: `AUDIT CHAIN BROKEN`, `"reason":"ANCHORED_HEAD_MISSING"`,
  and `missingHeads`, the indexes of the heads the log lacks. It exits 1.
- A banner on every console page, and the nightly-check card on `/audit-log`:
  "a head of this log written on chain is no longer in it".

## What it means

One of three things, in this order of likelihood:

1. **The database was restored from a backup older than the head.** The events
   the head stands for were lost with the database ([restore.md](restore.md)).
2. **A stolen issuer key wrote a head the firm never had.** The registry watch
   reports the write too, as an `AUDIT_HEAD` the journal did not make.
3. **The log was rewritten** by someone with the database owner's rights, and
   the check has caught them.

## What you need

- The registry owner, to void a head: today the deployer key; after
  [ownership-to-safe.md](ownership-to-safe.md) the Safe's signers.
- The network's RPC endpoint and Foundry's `cast`.
- An admin signed in to the console.

## Steps

1. **Change nothing in the database.** Take a dump of it as it is
   (`scripts/backup.sh`): if the log was rewritten, this is the evidence.

2. **Read each missing head.** Without `--send`, the owner tool prints the
   head, the key that wrote it and when, and sends nothing:

   ```sh
   npx tsx scripts/owner-call.ts sepolia void-audit-head <index>
   ```

3. **Tell the cases apart.**
   - Written by a key that is not the worker's, or reported by the registry
     watch as an `AUDIT_HEAD` the journal did not make: case 2. Follow
     [stolen-issuer-key.md](stolen-issuer-key.md) first: retire the key.
   - Written after the time of the backup the database was restored from:
     case 1.
   - Anything else: case 3. Find the latest backup whose audit log holds the
     head; the events after it are what was rewritten. Treat the database
     owner's account as compromised, and do not void the head.

4. **In cases 1 and 2 only, have the owner void the head**, by executing the
   transaction the tool printed. In a Safe, several voids go in one batch.
   While the owner is a single key on a testnet rehearsal, `--send` with
   `OWNER_PRIVATE_KEY` sends it. A void is final and public: it says, on
   chain, that the firm's log does not hold this head.

5. **Run the check again** (`npm run audit:check`). Once every head left is in
   the log, it says intact, and the banner goes.

6. **Record** in the incident log which heads were voided and why. In case 1,
   list what the lost events covered, from the journal and the chain
   ([restore.md](restore.md), step 5).

## Never

- Void a head so that a rewritten log passes the check. That is the one thing
  the heads exist to prevent, and the void stays on chain for anyone to see.
- Edit `AuditEvent` or `AuditChainCheck` rows to match the chain.
- Ask the registry's owner to void a head without the head, its key and its
  time in front of them.
