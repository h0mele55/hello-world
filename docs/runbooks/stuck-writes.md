# Writes that do not finish

Every chain write is a `ChainWrite` row: INTENT, then BROADCAST, then FINAL
(or SIMULATED, FAILED, INDETERMINATE). The worker moves each row only by
reading the chain, and never sends a write twice (rule 3). Most "stuck" rows
settle by themselves; this runbook is for the ones that do not.

Find the rows that are not settled:

```sql
SELECT id, kind, status, error, issuer, nonce, "txHash", "updatedAt" FROM "ChainWrite"
WHERE status IN ('INTENT', 'BROADCAST', 'INDETERMINATE') ORDER BY "createdAt";
```

## BROADCAST for a long time

A row is BROADCAST until its block is finalized, which on Sepolia takes about
13 minutes after it is mined. One whose transaction has not been mined after
10 minutes is replaced at the same nonce with higher fees, automatically. Both
are normal. Replacement is bounded (#139): after 6 replacements
(`REPLACEMENTS_EXHAUSTED`), or when the next fee cap would pass
`WORKER_MAX_FEE_GWEI` (`FEE_CEILING_REACHED`), the row stops being replaced
and waits. A refused replacement counts, and its hash stays in the journal.
The monitor's `FINALITY_LAG` is measured from the first send, so it fires an
hour after that whatever the replacements did, and names their number.
Check:

- The worker is running and its passes say `"ran": true`. If it is not
  running, see [rpc-outage.md](rpc-outage.md).
- The issuer key has funds. Below 0.02 ETH every console page shows a banner;
  fund the key, and the next pass carries on.
- For `REPLACEMENTS_EXHAUSTED` or `FEE_CEILING_REACHED`: find out why the
  transaction is not mined (a gap at an earlier nonce, an endpoint that does
  not propagate, a fee market above the ceiling). Raise `WORKER_MAX_FEE_GWEI`
  only on purpose; restarting the worker with a new value lets replacement go
  on.

## INDETERMINATE

The worker could not tell whether a transaction left. For example, it died
after signing, or the node did not answer the send. The row is settled from
chain state: the receipts for every hash it signed, the node's pool, the
issuer's finalized nonce, and the record for the document. While any row of an
issuer key is INDETERMINATE, no new LIVE write starts for that key
(`ISSUER_BLOCKED`), because its next nonce is unknown.

Most INDETERMINATE rows settle within a few passes. One that cannot shows in
the worker's log as:

```text
INDETERMINATE write cannot be settled from chain state; the issuer key is held until it is
```

This happens when none of its transactions is mined or known to the node, and
its nonce is still unused, so it could still land. Only then, an approver
releases the nonce:

```sh
npx tsx scripts/settle-write.ts <chainWriteId> --operator <approver email>
```

It sends a zero-value transfer to the issuer at that nonce, recorded in the
audit log under the approver's name before it is sent. Once that transfer is
final, the worker marks the write FAILED (`NONCE_CONSUMED`), releases the key,
and the version waits for approval again. It refuses, by name, anything else:

| Refusal | Meaning |
| --- | --- |
| `NOT_FOUND`, `NOT_INDETERMINATE` | Not the row you meant, or it settled meanwhile. |
| `TX_ON_CHAIN_OR_KNOWN` | One of its transactions is mined or in the pool: let the worker settle it. |
| `NONCE_NOT_NEXT` | The nonce is already used, or another one comes first: let the worker settle it. |
| `WRONG_ISSUER` | The settings hold another key than the row's. |
| `ISSUER_LOCKED` | A worker holds the key: stop it first. |
| `OPERATOR_NOT_APPROVER` | `--operator` is not an approver of the firm. |
| `SEND_REJECTED`, `SEND_UNKNOWN` | The transfer was refused, or its outcome is unknown: the worker reads it next pass. |

`--operator` names the approver who decided; it is not a sign-in. The audit
log records it as named at the command line (`namedOperatorId`), not as the
event's actor. Access to the issuer key and the database is what limits who
can run this.

### `RECORD_MISMATCH`

The write's transaction is final and succeeded, but the record it made is not
the one the journal says it sent (another parent, block, issuer or document;
for an audit-log head, no event naming the head). The worker holds it, and
the issuer key with it, on every pass (`held for a person: the record does not
match the write`), because what it means is a person's call. Find out why:

- Read the transaction and the record in the explorer and compare them with
  the row (`parentId`, `recordId`, `blockNumber`, `auditHead`).
- A record written by a stolen key, or a deployment that is not the build's,
  is a different incident: see [stolen-issuer-key.md](stolen-issuer-key.md).
- A chain whose block numbers the registry reads wrongly was #138.

Once you know, an approver releases it. This needs only `DATABASE_URL` and
sends nothing:

```sh
npx tsx scripts/settle-write.ts <chainWriteId> --operator <approver email> --release-mismatch
```

The worker then reads the receipt and the record again on both endpoints at
an agreed finalized block. If they now match, the write is FINAL as usual. If
they still do not, it is FAILED with `RECORD_MISMATCH_RESOLVED`, keeping its
nonce and hash (its transaction used them), and the key is free: an anchor or
a revocation waits for approval again. It refuses `NOT_RECORD_MISMATCH` for any
other row, and `OPERATOR_NOT_APPROVER` for anyone but an approver of the firm.

## FAILED

A FAILED row stays failed, with its reason in `error` and on the version page:

- **An anchor** goes back to waiting for approval. An approver reads the
  reason and approves again when it is fixed.
- **A stamped copy** leaves the version ANCHORED. An approver presses
  "Retry copy".
- **A revocation** goes back to waiting for approval.

A refusal named after the contract (for example `StaleParent`,
`DocAlreadyAnchored`) means the chain refused it in simulation and nothing was
sent.

## Never

- Resend a transaction by hand, or set a row's status, nonce or hash with SQL.
- Run `settle-write.ts` while a transaction of the row may still land.
- Delete a row: it is the record of what was sent.
