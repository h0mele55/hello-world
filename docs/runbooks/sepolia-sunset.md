# Sepolia is being shut down

Sepolia is a test network. When it is shut down, its endpoints stop
answering. From then on:

- every verification of a prototype anchor is "cannot verify";
- no new anchors can be made.

This is why testnet anchors are prototype evidence and never legally binding
(rule 9).

## What exists today

Nothing yet carries a Sepolia anchor past Sepolia. Three pieces of Phase 6
will:

| Issue | What it does |
| --- | --- |
| #63 | The production chain: Arbitrum One, chosen by the owner on 2026-10-26. |
| #65 | `scripts/reanchor.ts`: one Merkle root of every Sepolia record, committed on the production chain, with a proof per record that the verifier accepts. |
| #66 | A Bitcoin timestamp of each manifest (OpenTimestamps), independent of any Ethereum network. |

## When a sunset is announced

Shutdowns of Ethereum test networks are announced months ahead. Watch the
Ethereum Foundation's announcements and those of the two RPC providers.

1. **Stop new anchors on Sepolia.** An approver sets the write mode to
   DISABLED. Writes in flight are still settled.
2. **Re-anchor** while Sepolia still answers. Steps 2 and 3 need #65:
   1. read every record from the registry's logs;
   2. commit the root on the production chain, Arbitrum One;
   3. publish the proof files;
   4. check every proof against the root.
3. **Switch the verifier** to accept a Sepolia record through its proof.
   Publish a new `verifier.html` (#85).
4. **Tell recipients and clients** which reports were re-anchored and where.

If the shutdown comes before #65 exists, prototype anchors simply stop being
verifiable. The reports themselves, and the firm's records of them, are
unaffected.
