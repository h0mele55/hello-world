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
are normal. Check:

- The worker is running and its passes say `"ran": true`. If it is not
  running, see [rpc-outage.md](rpc-outage.md).
- The issuer key has funds. Below 0.02 ETH every console page shows a banner;
  fund the key, and the next pass carries on.

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
