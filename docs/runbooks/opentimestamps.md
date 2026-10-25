# A version's Bitcoin timestamp is missing, late or wrong

Each version whose anchor is final gets a second timestamp of its manifest
hash, on Bitcoin through OpenTimestamps (#66). `npm run ots` submits it,
upgrades it once Bitcoin has confirmed it, and checks the block against two
explorers (`docs/operations.md`, "The OpenTimestamps job"). The anchor on
chain does not depend on it: a version without a Bitcoin timestamp is still
anchored. The version's page shows where its proof stands.

Every query below reads; none changes a row. Never edit `OtsProof` by hand: a
proof marked COMPLETE must be one the check passed.

## `OTS_NOT_SUBMITTED`: a version has no proof a day after its approval

- Is the job running? Each pass logs `"ots pass"`. After 20 failed passes in
  a row it exits for its supervisor to restart it.
- Does it name the version under `notSubmitted`? Then fewer than two
  calendars took the digest. The calendars are public services and sometimes
  go down; the job tries again every pass. If one has gone for good, the list
  is `OTS_CALENDARS` in `src/lib/ots/calendar.ts`: change it in a pull
  request.

## `OTS_PENDING_LONG`: a proof has waited two days for Bitcoin

Calendars usually put their batch on Bitcoin within a few hours. The alert
lists the reasons the last passes recorded:

```sql
SELECT "reportVersionId", "submittedAt", "checkedAt", "lastError", calendars
FROM "OtsProof" WHERE status = 'PENDING' ORDER BY "submittedAt";
```

| `lastError` | What it means | What to do |
| --- | --- | --- |
| none | the calendars answer "not yet" | wait a little longer, then check the calendars' status pages |
| `CALENDARS_UNREACHABLE` | every calendar the proof names failed to answer | check the server reaches them over HTTPS (port 443) |
| `BITCOIN_UNREADABLE` | an explorer could not be read | check the server reaches blockstream.info and mempool.space |
| `BITCOIN_DISAGREE` | the two explorers gave different blocks at the height | usually one is behind or mid-reorganisation; it clears on a later pass. If it lasts, compare the two by hand and report it |
| `BITCOIN_BAD_HEADER` | both explorers gave a header without Bitcoin's proof of work | do not trust either explorer until you know why; report it |

The proof can also be checked by hand, independently of this app, with the
reference client: download it from the version's page, then run
`ots upgrade report-v1-manifest.ots` and `ots verify -d <manifestHash without
0x> report-v1-manifest.ots`. Running `ots verify` against a Bitcoin node of
your own trusts no explorer at all.

## `OTS_BROKEN`: a proof does not lead to the block it names

The job checked a Bitcoin attestation and the proof's path does not reach that
block's Merkle root (`NOT_IN_BLOCK`), or the stored proof no longer parses
(`PROOF_*`). The version shows no Bitcoin time. The anchor on chain is
unaffected.

1. Download the proof from the version's page and run `ots verify` on it as
   above. If the reference client agrees it is wrong, a calendar served a bad
   path: the proof's pending attestations name the calendars it went to.
   Report it to that calendar's operator.
2. If the reference client says it is fine, the job's check is wrong: open an
   issue with the proof attached (it holds no confidential data: the manifest
   hash is on chain, and the rest is a nonce and hashes).
3. The job never touches a BROKEN proof again. The alert stays for a day; the
   version's page keeps showing it.

Never mark a proof COMPLETE by hand, and never delete the row.
