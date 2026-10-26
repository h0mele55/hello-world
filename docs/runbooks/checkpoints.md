# Monthly checkpoints of the registry

The registry's records stay readable only while its chain does, and Arbitrum
One's records last as long as Arbitrum's infrastructure, or someone's archive
of it. So once a month every record the registry holds goes under one Merkle
root, and that checkpoint is timestamped on Bitcoin through OpenTimestamps
(#122). The owner chose Bitcoin on 2026-10-26: it is free, it is the hardest
chain to lose, and the OpenTimestamps job (#66) already runs.

A Bitcoin timestamp proves when the checkpoint existed; it does not store it.
The firm publishes each checkpoint, and keeps it.

## What runs

| When | What | Result |
| --- | --- | --- |
| The 1st of each month, e.g. `23 1 1 * *` | `npm run checkpoint` | the previous month's checkpoint: every record at one finalized block both `<NETWORK>_RPC_URL` and `<NETWORK>_RPC_URL_2` agree on, kept in `RegistryCheckpoint` (append-only), `checkpoint.created` in the audit log. A second run in the month changes nothing; a registry with no records has nothing to checkpoint. |
| Every pass of `npm run ots` | the OpenTimestamps job | submits the SHA-256 of the checkpoint's head, then upgrades and checks it against Bitcoin, as for a manifest hash (`ots.*` events with subject `RegistryCheckpoint`) |
| Once its proof is COMPLETE, usually within a day | `npm run checkpoint -- --export <YYYY-MM> --out <dir>` | the files to publish (below) |

The head is the ABI encoding of a tag, the chain, the registry, the block, the
month, the record count and the root (`checkpointHead` in
`src/lib/verify-core/reanchor.ts`). Timestamping the head, not the bare root,
gives every month a timestamp of its own, even a month in which nothing was
anchored.

## Publishing

The export writes:

| File | What |
| --- | --- |
| `checkpoint.json` | every record at the block (format `checkpoint/1`), the root, and the `.ots` proof |
| `proofs/<recordId>.json` | one record's proof (`checkpoint-proof/1`): the record, its original if it is a copy, its family's latest, each with its path to the root, and the `.ots` |
| `head`, `head.ots` | the head's bytes and its OpenTimestamps proof, for the reference client |

Attach the directory, zipped, to a release of the repository named
`checkpoint-<YYYY-MM>`, and keep a copy with the firm's records. Nothing in it
is confidential: the records hold commitments and pseudonymous ids only, which
the chain already shows (rule 1).

Anyone can check the timestamp without this app:

```bash
ots verify head.ots          # reads `head` beside it
```

## Verifying through a checkpoint

For the day the registry cannot be read, the CLI verifier takes the
checkpoint (or one record's proof):

```bash
node bin/verify-report.mjs report.pdf --checkpoint checkpoint.json
```

It uses the checkpoint only when the registry cannot be reached, and only
through its Bitcoin timestamp: the proof must be of this checkpoint's head and
reach a Bitcoin block both explorers agree on. Anything short of that is
`CHECKPOINT_UNPROVEN`. The verdict is the one the registry gave at the
checkpoint's block, and `reanchored` names the month, the block and the
Bitcoin block. A checkpoint cannot say a file was never anchored, since it may
have been anchored after it: a file or record it does not hold is
`CHECKPOINT_NOT_COVERED`, never "not registered". A revocation or a new version
after the checkpoint is not in it either.

## When something goes wrong

| Alert | Meaning | Do |
| --- | --- | --- |
| `CHECKPOINT_MISSING` | a month ended with a version anchored, and by the 3rd there is no checkpoint for it | Run `npm run checkpoint` by hand and read what it says. It refuses with a name when the endpoints disagree or the deployment record is wrong (`docs/runbooks/rpc-outage.md`). A late checkpoint is still a checkpoint: it holds every record up to the block it was read at. |
| `OTS_NOT_SUBMITTED` with `checkpoints` | the OpenTimestamps job has not submitted a checkpoint for a day | `docs/runbooks/opentimestamps.md` |
| `OTS_PENDING_LONG`, `OTS_BROKEN` | as for a version's proof | `docs/runbooks/opentimestamps.md` |

Never edit or delete a `RegistryCheckpoint` row (a trigger refuses it): what
was published must stay what the timestamp is of. A checkpoint made wrongly is
followed by the next month's, which holds every record again.
