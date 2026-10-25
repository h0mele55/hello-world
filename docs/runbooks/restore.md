# Restoring after the database or the file store is lost

The chain is the record of what was anchored; the database is the record of
why, by whom, and what the firm holds. A restore brings back the second up to
the time of the backup. Whatever was anchored after that is still on chain and
still verifies, but the console no longer knows it.

## Steps

1. **Stop the app, the worker and the mailer**, so nothing writes to a
   half-restored database.
2. **Restore** the latest backup into an empty database and an empty
   directory, and check it against the source if the source still exists. The
   commands are in `docs/operations.md`, under Restoring. `scripts/restore.sh`
   refuses a target that is not empty, and checks the backup's checksums
   first.
3. **Start the app alone**, not the worker or the mailer, and have an approver
   set the firm's write mode to **DISABLED** in Settings. Narrowing takes
   effect at once and is audited. No write that was waiting in the backup
   starts while you look.
4. **Start the worker** and let it run a few passes. Rows that were in flight
   at the time of the backup are settled from chain state:
   - **A write the backup shows as sent** (BROADCAST, or INTENT with a hash) is
     settled from the chain: FINAL if it landed after the backup.
   - **A write the backup shows as not yet sent** fails `MODE_NARROWED`, and its
     version waits for approval. If it was in fact sent after the backup, an
     approval under LIVE finds the document on chain and links it, sending
     nothing: its commitments are in the restored database.
5. **Find what the backup does not know**: `npm run reconcile:chain` (#111).
   It reads every version the database holds
   against the registry at one finalized block both endpoints agree on, scans
   every record the firm's issuer keys wrote, and prints a `DIFFERENCE` line
   for each disagreement. It writes nothing. Expect these after a restore:

   | Code | What happened since the backup | What to do |
   | --- | --- | --- |
   | `ANCHORED_AFTER_BACKUP`, `COPY_ANCHORED_AFTER_BACKUP` | the version, or its copy, was anchored | nothing to fix: once the write mode is LIVE again, an approval (for a copy, a retry) finds the record on chain and links it, sending nothing |
   | `REVOCATION_PENDING_ON_CHAIN`, `REVOKED_ON_CHAIN` | a revocation was asked for, or took effect | if the firm asked for it, ask again in the console, which links it; if nobody did, [stolen-issuer-key.md](stolen-issuer-key.md) at once |
   | `SCHEDULED_NOT_ON_CHAIN` | the owner cancelled a revocation | nothing: the worker settles it as CANCELLED |
   | `UNKNOWN_RECORD` | a version uploaded after the backup, lost with its salts and manifest | it still verifies for anyone who holds it; list it for the firm's records, and review the registry watch's finding for it on `/audit-log` |

   Anything else (`RECORD_MISSING`, `RECORD_DIFFERS`, `COPY_MISSING`,
   `COPY_DIFFERS`, `REVOKED_NOT_ON_CHAIN`) means the database says something
   the chain never did: a damaged backup, or one from another deployment.
   Stop, and restore the one before it. Run the command again after step 7:
   what was linked or settled since no longer shows.
6. **Run the audit-chain check** (`npm run audit:check`). It must say intact,
   except for the audit-log heads written on chain after the backup was taken
   (#94): their events were lost with the database, and the check names them
   (`ANCHORED_HEAD_MISSING`, `missingHeads`). Confirm each was written after
   the backup's time, then follow [audit-head-missing.md](audit-head-missing.md)
   to have the owner void them. The backup runs after the nightly check, so the
   checks it restored match the chain it restored. Anything else is a damaged
   backup: stop, and restore the one before it.
7. **Widen the write mode** (an approver, in Settings: DRY_RUN, then LIVE),
   start the mailer, and check `/audit-log` and `/dashboard`.

## Never

- Restore over a database that still holds data: restore into a new one, and
  switch.
- Put `FILE_ENCRYPTION_KEY` next to the backups. Without it the files and
  every sealed column cannot be read; keep it in the secret manager.
