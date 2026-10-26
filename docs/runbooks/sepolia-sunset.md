# Sepolia is being shut down

Sepolia is a test network. When it is shut down, its endpoints stop
answering. From then on:

- every verification of a prototype anchor is "cannot verify";
- no new anchors can be made.

This is why testnet anchors are prototype evidence and never legally binding
(rule 9).

## What exists today

| Issue | What it does |
| --- | --- |
| #63 | The production chain: Arbitrum One, chosen by the owner on 2026-10-26. |
| #65 | `scripts/reanchor.ts`: an archive of every Sepolia record and its Merkle root, which the registry's owner records on the production registry, and a proof per record. The CLI verifier accepts both (`--reanchor`). Rehearsed on two Anvil chains (`tests/integration/reanchor.test.ts`). |
| #126 | `/verify` and `verifier.html` accepting them too. Not built yet. |
| #66 | A Bitcoin timestamp of each manifest (OpenTimestamps), independent of any Ethereum network. |

A re-anchored family is frozen at the snapshot: the production registry
cannot yet take its next version (#127, the owner's decision).

## When a sunset is announced

Shutdowns of Ethereum test networks are announced months ahead. Watch the
Ethereum Foundation's announcements and those of the two RPC providers.

1. **Stop new anchors on Sepolia.** An approver sets the write mode to
   DISABLED. Writes in flight are still settled.
2. **Wait out every revocation.** A revocation asked for less than
   `revocationDelay` ago would stay "being withdrawn" for ever in the
   archive, so the build refuses one (`REVOCATION_PENDING`, naming the record
   and when it takes effect). Wait until then, or have the owner cancel it.
3. **Build the archive** once Arbitrum One's registry is deployed
   (`deployments/arbitrum.json`, #123) and while Sepolia still answers, from both endpoints
   (`SEPOLIA_RPC_URL`, `SEPOLIA_RPC_URL_2`) at one finalized block they agree
   on:

   ```bash
   npx tsx scripts/reanchor.ts build sepolia arbitrum
   ```

   It writes `reanchor/sepolia-<block>/archive.json` (every record, the root)
   and `proofs/<recordId>.json` (one per record: the record, its original if
   it is a copy, and its family's latest, each with its path to the root).
   An existing directory is never written over. The files hold only what
   Sepolia already made public: commitments, pseudonymous ids, the firm's
   name (rule 1).
4. **Record the root.** The owner (the Safe, #67) executes the call this
   prints:

   ```bash
   npx tsx scripts/owner-call.ts arbitrum record-reanchor-root reanchor/sepolia-<block>/archive.json
   ```

   It refuses an archive that does not hash to its own root or was built for
   another registry. Only the owner can record a root: it vouches for every
   record under it. A root recorded in error is voided with
   `owner-call.ts arbitrum void-reanchor-root <index>`, and the right one is
   recorded anew.
5. **Check every proof against the recorded root**, on both
   `ARBITRUM_RPC_URL` and `ARBITRUM_RPC_URL_2`, once its block is finalized:

   ```bash
   npx tsx scripts/reanchor.ts check reanchor/sepolia-<block> arbitrum
   ```

   It prints one `DOES NOT PROVE` line per failure and exits 1. It needs no
   Sepolia endpoint, so run it again after the shutdown.
6. **Publish** the archive and the proofs: commit the directory, and give
   each client the proofs of their reports. Anyone can then check a file
   with the CLI:

   ```bash
   node bin/verify-report.mjs report.pdf --reanchor archive.json
   ```

   The verdict is the one Sepolia gave at the snapshot, and `reanchored`
   names the root and the Arbitrum block it was recorded in. A proof asked
   about a record it does not hold says `REANCHOR_NOT_COVERED`; it never
   says "not registered".
7. **Switch the browser verifiers** once #126 is built, and publish a new
   `verifier.html` (#85).
8. **Tell recipients and clients** which reports were re-anchored and where.

If the shutdown comes before step 5, prototype anchors simply stop being
verifiable. The reports themselves, and the firm's records of them, are
unaffected.
