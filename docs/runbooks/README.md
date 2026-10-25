# Runbooks

What to do when something goes wrong, or when a key or an owner must change.
Each runbook says when it applies, what to check first, the steps, and what
never to do. `docs/operations.md` says what runs day to day, and
`docs/threat-model.md` says why each safeguard exists.

| Runbook | When |
| --- | --- |
| [key-rotation.md](key-rotation.md) | Replacing the issuer key: on a schedule, when moving to KMS, or because it may be stolen |
| [stolen-issuer-key.md](stolen-issuer-key.md) | A revocation nobody at the firm asked for: the owner cancels it within the registry's delay (#95) |
| [kms-key.md](kms-key.md) | Making the issuer key in Cloud KMS and switching the worker to it (the key ceremony) |
| [ownership-to-safe.md](ownership-to-safe.md) | Moving the registry's ownership from the deployer key to a Safe (#67) |
| [stuck-writes.md](stuck-writes.md) | A write that does not reach FINAL, an issuer key held by an INDETERMINATE write, a low balance |
| [rpc-outage.md](rpc-outage.md) | An RPC endpoint that is down, slow or disagrees, for the worker or the verifier |
| [restore.md](restore.md) | The database or the file store is lost or damaged |
| [audit-head-missing.md](audit-head-missing.md) | The nightly check finds a head of the audit log on chain that the log no longer holds (#94) |
| [mail.md](mail.md) | Recipients are not getting their email |
| [opentimestamps.md](opentimestamps.md) | A version has no Bitcoin timestamp, one waits too long, or a proof turned out wrong (#66) |
| [sepolia-sunset.md](sepolia-sunset.md) | Sepolia is being shut down |

Two rules hold in every runbook:

- **Never resend a chain write by hand, and never edit `ChainWrite`, `AuditEvent`
  or `ReportVersion` rows.** The journal is the record of what was sent; the
  worker settles every row from chain state (rules 3 and 7).
- **Every act that changes a key or the owner is the owner's.** The scripts
  print the transaction; the owner executes it.

The prototype runs on a public testnet. Nothing here makes its anchors legally
binding (rule 9).
