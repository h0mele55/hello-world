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
5. **Find what the backup does not know.** Compare the registry's events since
   the backup's time with the journal: the issuer key's transactions on the
   explorer, against the `ChainWrite` rows with a later `updatedAt`. Every
   anchor without a row belongs to a version uploaded after the backup.
   - Those reports still verify for anyone who holds them.
   - Their salts and manifests are lost with the database, so they cannot be
     re-linked in the console.
   - List them for the firm's records. Re-deriving every verdict from the
     chain automatically is Phase 6 work.
   - The registry watch reports these writes too, since the restored journal
     does not hold them: review each on `/audit-log` once it is explained.
6. **Run the audit-chain check** (`npm run audit:check`). It must say intact.
   The backup runs after the nightly check, so the checks it restored match the
   chain it restored. Anything else is a damaged backup: stop, and restore the
   one before it.
7. **Widen the write mode** (an approver, in Settings: DRY_RUN, then LIVE),
   start the mailer, and check `/audit-log` and `/dashboard`.

## Never

- Restore over a database that still holds data: restore into a new one, and
  switch.
- Put `FILE_ENCRYPTION_KEY` next to the backups. Without it the files and
  every sealed column cannot be read; keep it in the secret manager.
