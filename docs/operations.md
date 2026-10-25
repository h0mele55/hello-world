# Operations

What runs besides the app, how often, and how to restore. The prototype runs
on a public testnet; none of this makes its anchors legally binding (rule 9).

## What runs, and when

| Process | How | Schedule | It alerts by |
| --- | --- | --- | --- |
| The anchoring worker | `npm run worker` | continuously, a pass every 15 s | error log lines; the console's low-balance banner |
| The mailer | `npm run mailer` | continuously, a pass every 30 s (`MAILER_INTERVAL_MS`) | an error line naming notices that failed for good |
| The audit-chain check | `npm run audit:check` | nightly, e.g. `17 2 * * *` | exit code 1 and an `AUDIT CHAIN BROKEN` error line; the console's banner |
| The backup | `scripts/backup.sh` | nightly, after the check, e.g. `37 2 * * *` | a non-zero exit code |

Run the check and the backup from the app's directory with the app's
environment. The check reads `DATABASE_URL` only. The backup also needs
`FILE_STORAGE_DIR` and `BACKUP_DIR`.

## The mailer

When a newer version of a report is complete, everyone listed as holding the
engagement's report is queued an email. `npm run mailer` sends them. It needs
`DATABASE_URL`, `SMTP_URL`, `MAIL_FROM` and `APP_PUBLIC_URL` (for the links),
and holds no issuer key.

- It sends at least once. A notice is claimed under a one-minute lease; if
  the mailer dies before marking it sent, it is sent again once the lease
  runs out. A recipient can get the same notice twice; none is lost.
- A failed send is retried on the next pass. After five failed attempts the
  notice is FAILED, the audit log records `notification.failed`, and the
  pass logs an error line with its id. Only a name for the error is kept
  (for example `EENVELOPE`), never the server's reply.
- `SMTP_URL` can hold the server's credentials (`smtps://user:password@host`).
  It is never logged; keep it with the other secrets.
- Each engagement's page shows, per recipient, the last notice and whether it
  was sent.

## The audit-chain check

Each night `npm run audit:check` re-derives every firm's chain. It also holds
the chain to the last check that found it intact:

- the chain may only have grown since then;
- the event that was its head then must still be there, with the same hash.

A chain that verifies on its own can still have had its tail cut off. It can
also have had history rewritten and re-hashed by someone who controls the
database. The check names either case: `TRUNCATED` or `REWRITTEN`.

Every run is recorded (`AuditChainCheck`), and `/audit-log` shows the latest
result. A broken check puts a banner on every console page. A check older than
36 hours shows as stopped. A break stays reported: later checks are compared
with the last intact one, not with the break.

## Backups

`scripts/backup.sh` writes `<BACKUP_DIR>/<UTC time>/`:

- `db.dump`: `pg_dump` in custom format;
- `files.tar`: the encrypted file store as it is on disk;
- `SHA256SUMS`.

The dump runs first, so every file a dumped row names is already in the store.

**Keys are not in the backup.** Without `FILE_ENCRYPTION_KEY`, the files and
every sealed column (opinions, manifests, notes, TOTP secrets) cannot be read.
Keep the key in a secret manager, never next to the backups.

The dump still holds plain metadata: client names, user emails, password
hashes, and recipients' names and email addresses. Keep backups on storage that is itself encrypted and access-controlled.

## Restoring

1. Create an empty database and choose an empty directory. `scripts/restore.sh`
   refuses any target that already holds a table or a file. It never restores
   over data.
2. Restore:

   ```sh
   RESTORE_DATABASE_URL=… RESTORE_FILE_STORAGE_DIR=… scripts/restore.sh <backup dir>
   ```

   It checks `SHA256SUMS` before it touches anything.
3. Check the copy against the source:

   ```sh
   DATABASE_URL=<source> RESTORE_DATABASE_URL=… RESTORE_FILE_STORAGE_DIR=… \
   FILE_ENCRYPTION_KEY=… npx tsx scripts/verify-restore.ts
   ```

   It confirms three things:
   - the same migrations are applied;
   - every firm's audit chain re-derives, and its head is the source's event;
   - every stored file opens and matches its SHA-256.

   It also prints row counts beside the source's.
4. Point the app and the worker at the restored database and directory.

CI runs this whole round trip after the end-to-end tests (`npm run
test:backup`). That run is the tested restore. It also checks the two
refusals: a backup that fails its checksums, and a target that is not empty.
