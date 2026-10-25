# Operations

What runs besides the app, how often, and how to restore. The prototype runs
on a public testnet; none of this makes its anchors legally binding (rule 9).

## What runs, and when

| Process | How | Schedule | It alerts by |
| --- | --- | --- | --- |
| The anchoring worker | `npm run worker` | continuously, a pass every 15 s | error log lines; the console's low-balance and endpoint-disagreement banners |
| The mailer | `npm run mailer` | continuously, a pass every 30 s (`MAILER_INTERVAL_MS`) | an error line naming notices that failed for good |
| The OpenTimestamps job | `npm run ots` | continuously, a pass every 5 min (`OTS_INTERVAL_MS`) | an error line naming a proof that turned out wrong; the monitor's `OTS_*` alerts |
| The audit-chain check | `npm run audit:check` | nightly, e.g. `17 2 * * *` | exit code 1 and an `AUDIT CHAIN BROKEN` error line, naming any head on chain the log lacks; the console's banner |
| The registry watch | `npm run watch:registry` | every ten minutes, e.g. `*/10 * * * *` | exit code 1 while any write the journal did not make is unreviewed, an error line for each new one; the console's banner |
| The backup | `scripts/backup.sh` | nightly, after the check, e.g. `37 2 * * *` | a non-zero exit code |
| The monitor | `npm run monitor` | every ten minutes, e.g. `*/10 * * * *` | exit code 1 and an `ALERT` line for each thing that needs a person; route it to whoever is on call |

Run the check, the watch and the backup from the app's directory with the
app's environment. The check reads `DATABASE_URL` and the chain (see below).
The watch reads `ANCHOR_NETWORK`, its `<NETWORK>_RPC_URL` and the deployment
record. Neither holds a key. The backup also needs `FILE_STORAGE_DIR` and
`BACKUP_DIR`.

The watch must run often, not nightly: a revocation it reports takes effect
after the registry's delay (24 hours by default), and the owner must cancel it
before then (`docs/runbooks/stolen-issuer-key.md`).

The worker reads two RPC endpoints from different providers,
`<NETWORK>_RPC_URL` and `<NETWORK>_RPC_URL_2`, and settles a row only on what
both read (#92); it refuses to start without the second.

Run the worker, the mailer and the OpenTimestamps job under a supervisor that restarts them (for
example a systemd unit with `Restart=always`). Each tries a failed pass again
after its interval, logging `pass failed` with a count; after 20 failures in a
row it exits 1, so the supervisor restarts it with fresh connections. When
something goes wrong, `docs/runbooks/` says what to do.

## The mailer

When a newer version of a report is complete, everyone listed as holding the
engagement's report is queued an email; so they are when a revocation takes
effect and a version is withdrawn (#96), with the reason's label and never the
firm's note. `npm run mailer` sends them. It needs
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

## The monitor

`npm run monitor` (#68) reads the database only and prints one `ALERT` line
for each of these, with ids, codes and times, never a client or a file:

| Code | What | Runbook |
| --- | --- | --- |
| `WRITE_FAILED` | a chain write failed in the last day | [stuck-writes.md](runbooks/stuck-writes.md) |
| `WRITE_INDETERMINATE` | a write's outcome is unknown; its issuer key is held | [stuck-writes.md](runbooks/stuck-writes.md) |
| `FINALITY_LAG` | a write was sent more than an hour ago and is not final | [stuck-writes.md](runbooks/stuck-writes.md) |
| `WORKER_STOPPED` | work waits for a key whose worker has not passed in ten minutes | restart the worker |
| `LOW_BALANCE` | the issuer key's balance is below 0.02 ETH | [stuck-writes.md](runbooks/stuck-writes.md) |
| `RPC_DISAGREE` | the worker's two endpoints disagree | [rpc-outage.md](runbooks/rpc-outage.md) |
| `AUDIT_CHECK_BROKEN` / `AUDIT_CHECK_STALE` | the nightly check found a break, or has not run for 36 hours | [audit-head-missing.md](runbooks/audit-head-missing.md) for a missing head |
| `WATCH_STALE` / `UNJOURNALED_OPEN` | the registry watch has not run for two hours, or found a write nobody has reviewed | [stolen-issuer-key.md](runbooks/stolen-issuer-key.md) |
| `NOTICE_FAILED` | the mailer gave up on a notice in the last day | [mail.md](runbooks/mail.md) |
| `OTS_NOT_SUBMITTED` | a version approved more than a day ago is final on chain and has no OpenTimestamps proof | [opentimestamps.md](runbooks/opentimestamps.md) |
| `OTS_PENDING_LONG` | a proof has waited more than two days for Bitcoin | [opentimestamps.md](runbooks/opentimestamps.md) |
| `OTS_BROKEN` | a proof turned out not to lead to the block it names, in the last day | [opentimestamps.md](runbooks/opentimestamps.md) |

A failure stays reported for a day. A key with no work waiting is not
watched, so a retired key's stopped worker raises nothing. The verifier runs
in visitors' browsers and reports nothing home, so its errors are seen only by
the visitor ("cannot verify right now").

## The OpenTimestamps job

Each version's manifest hash also gets a second, independent timestamp, on
Bitcoin through [OpenTimestamps](https://opentimestamps.org) (#66). It rests
neither on the firm's registry nor on the chain the report is anchored on: a
proof shows that the manifest hash existed by the time of a Bitcoin block.
`npm run ots` (`src/lib/ots/job.ts`) keeps them. It needs `DATABASE_URL`
only, holds no key and writes no chain. Each pass:

- **submits** the manifest hash of every version whose anchor is final
  (ANCHORED, COMPLETE or REVOKED) to the four calendars the reference client
  uses (`OTS_CALENDARS` in `src/lib/ots/calendar.ts`). A random nonce is
  appended and the result hashed first, so the calendars see neither the
  manifest hash nor anything else. The proof is kept only once two calendars
  took it (`ots.submitted` in the audit log); otherwise the next pass tries
  again.
- **upgrades** each pending proof every 30 minutes: it asks each calendar a
  pending attestation names, if it is one of those four and only then,
  whether Bitcoin has confirmed its batch, and merges the path it answers.
- **checks** every Bitcoin attestation the proof then holds. It reads the
  block's 80-byte header from two explorers, blockstream.info and
  mempool.space (`BITCOIN_EXPLORERS` in `src/lib/ots/bitcoin.ts`). Both must
  return the same bytes, and those bytes must hash to the block each named.
  They must also meet the header's own proof-of-work target, at least as hard
  as Bitcoin's in 2015. The message the proof leads to must be the block's
  Merkle root. Only then is the proof COMPLETE, with the block's height, hash
  and time (`ots.complete`). A proof that leads elsewhere is BROKEN
  (`ots.broken`). An explorer that cannot be read, or two that disagree, leave
  the proof pending with a name for why, and the next pass tries again.

The version's page shows where its proof stands and offers the `.ots` file,
which the reference client (`ots verify`) checks without this app. Bitcoin's
block time is the miner's clock, within about two hours of the truth.

Every verifier shows the time beside an exact match's verdict. It asks the
public route `/ots/<manifestHash>` for the proof (readable from any origin,
rate-limited with the lookup page), checks it against the two explorers
itself, and never lets it change the verdict. So the app's server learns which
report a visitor checks, by its manifest hash, though never the file; with the
server down the verifier still decides and says the timestamp could not be
checked. `dist/verifier.html` and the CLI ask the origin in `APP_PUBLIC_URL`
at build time (or the CLI's `--app-url`).

## The audit-chain check

Each night `npm run audit:check` re-derives every firm's chain. It also holds
the chain to the last check that found it intact:

- the chain may only have grown since then;
- the event that was its head then must still be there, with the same hash.

A chain that verifies on its own can still have had its tail cut off. It can
also have had history rewritten and re-hashed by someone who controls the
database. The check names either case: `TRUNCATED` or `REWRITTEN`.

The last intact check is in the same database, so it is also held to the
chain (#94). The check reads the firm's audit-log heads in the registry, on
both endpoints at one finalized block, and every head the registry's owner
has not voided must still be the hash of one of its events
(`ANCHORED_HEAD_MISSING` otherwise, naming the heads;
`docs/runbooks/audit-head-missing.md`). A chain it cannot read is
`CHAIN_UNREADABLE`, never a pass. When the log has moved on since the last
head, it queues the new head in the journal, and the worker writes it like
any other write. It therefore reads `ANCHOR_NETWORK`, `ISSUER_ADDRESS`, the
deployment record and both `<NETWORK>_RPC_URL` and `<NETWORK>_RPC_URL_2`, and
refuses to start without them. A firm writes at most one head a day, and
none on a day it did nothing; nothing is queued while its write mode is
DISABLED.

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
