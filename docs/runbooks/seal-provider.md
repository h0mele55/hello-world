# The seal provider: a copy is not sealed, or the provider changes

When the firm seals its distribution copies (#70, `SEAL_PROVIDER=csc`), the
worker seals each stamped copy before storing and anchoring it. It does so
through the trust service provider's CSC API and an RFC 3161 timestamping
authority (`docs/operations.md`, "The electronic seal"). A copy is never
anchored unsealed while sealing is on. A copy that cannot be sealed waits, or
fails, and the original stays anchored and verifiable throughout.

Every query below reads; none changes a row. Never edit `ChainWrite` or
`ReportVersion` by hand, and never anchor a copy another way.

## `SEAL_WAITING`: a copy has waited an hour for the provider

The worker tries again on every pass. The row's `error` says which side did
not answer:

```sql
SELECT id, "reportVersionId", error, "createdAt" FROM "ChainWrite"
WHERE kind = 'ANCHOR_COPY' AND status = 'INTENT' AND error LIKE 'SEAL_%';
```

| `error` | What it means | What to do |
| --- | --- | --- |
| `SEAL_SIGNER_UNAVAILABLE` | the CSC API did not answer, or answered 429 or 5xx | check the server reaches `CSC_URL` (and `CSC_TOKEN_URL`) over HTTPS; check the provider's status page |
| `SEAL_TIMESTAMP_UNAVAILABLE` | the timestamping authority did not answer, answered 429 or 5xx, or asked to be tried later | check the server reaches `TSA_URL`; check the authority's status page |

Nothing more is needed: the next pass after the provider answers seals the
copy and anchors it. The worker's log has a `the copy could not be sealed`
line per attempt, with the code and the endpoint that failed.

## `WRITE_FAILED` with `STAMP_SEAL_…`: the provider refused, or the seal did not check

The copy's write is FAILED and the version stays ANCHORED. Nothing was stored
or sent. The version's page names the reason, and an approver can retry the
copy there once the cause is fixed.

| `error` | What it means | What to do |
| --- | --- | --- |
| `STAMP_SEAL_SIGNER_REFUSED` | the CSC API refused: a wrong client or secret, an unknown or disabled credential, a wrong PIN, or a credential that needs a person for each signature (an OAuth code or a one-time password, which an unattended worker cannot give) | read the worker's log line: it names the endpoint and the provider's error code. Fix the setting and restart the worker. A credential that needs a person is the wrong kind: ask the provider for a seal credential with implicit or PIN-only authorisation |
| `STAMP_SEAL_TIMESTAMP_REFUSED` | the authority refused (bad credentials, an unknown policy) or answered with a token for something else | check `TSA_USERNAME`, `TSA_PASSWORD` and `TSA_POLICY` |
| `STAMP_SEAL_UNTRUSTED` | the seal certificate does not chain to a root in `SEAL_TRUST_ANCHORS`, or was not valid at the timestamp's time (expired, or not yet valid) | if the provider renewed its certificate under a new root, add that root to the file. If the certificate expired, renew it with the provider. Never add a root you have not checked against the provider's published one |
| `STAMP_SEAL_BAD_TIMESTAMP` | the token is not over this signature, not signed by a timestamping authority, or does not chain to a root in `SEAL_TRUST_ANCHORS` | add the authority's root to the file if it is a different one from the seal's |
| `STAMP_SEAL_TOO_LARGE` | the signature and its timestamp do not fit the 32 KiB reserved | a very long certificate chain; open an issue |
| `STAMP_SEALED_…` | the sealed file did not re-read as the stamped copy plus a signature | open an issue with the code; do not retry until it is understood |

Then retry the copy from the version's page (an approver), and run one worker
pass.

## Changing the provider, or the seal's certificate

Copies already sealed keep their seal: they were anchored as sealed files, and
the anchor and the seal both stay checkable. To change:

1. Get the new provider's CSC API URL, client, credential and timestamping
   authority, and their roots as PEM.
2. Put the new values in the worker's environment. Put both the old and the
   new roots in `SEAL_TRUST_ANCHORS`, so a copy sealed by either checks.
3. Restart the worker. It refuses to start if a setting is missing or the
   roots file cannot be read.
4. Watch the next copy through to COMPLETE, and open it in a PDF reader: the
   signature panel names the new certificate.

To stop sealing, set `SEAL_PROVIDER=none` (or unset it) and restart the
worker. Copies made afterwards are stamped and anchored without a seal.

## Checking a sealed copy by hand

Any PDF reader shows the seal as a signature. Poppler's `pdfsig` checks it
with no part of this app:

```sh
pdfsig copy.pdf                    # Poppler: the signature, its signer and whether it covers the whole file
```

A qualified seal is checked against the EU trusted lists by a validator such
as the European Commission's DSS demonstration. Testnet anchors stay
prototype evidence whatever the seal says (rule 9).
