# Decision: the production chain (#63)

**Status: waiting on the owner.** Nothing here is deployed. The code handles
all four candidates and their Sepolia testnets. `scripts/deploy-registry.ts`
deploys only to the testnets, and refuses a production network until this
decision is made.

## The question

Testnet anchors are prototype evidence (rule 9), and Sepolia will be shut down
one day. A firm that relies on the tool needs its records on a chain meant to
last. The candidates are:
- **Ethereum mainnet**;
- **three rollups that settle on it**: Base, OP Mainnet and Arbitrum One.

What matters for this product, in order:

1. **That a record can still be read in ten or twenty years**, by someone
   other than the firm, without the firm's help. Audit files are kept for
   years; a verdict has to be checkable for as long as the report is relied on.
2. **That nobody but the firm can change or censor its records**, and that a
   reorganisation of the chain cannot undo one (rule 2).
3. **Cost per report**, and how much it moves.
4. **Time to `finalized`**: how long a report waits before the console calls
   it anchored.
5. **Explorers and tooling.**

## Measured cost and finality

Measured on 2026-10-25 at 12:27 UTC with `scripts/measure-chain-costs.ts`.
Anyone can run it again; it sends nothing and needs no key.

- **The fees** come from each chain's last 1,024 blocks (`eth_feeHistory`,
  median and 90th percentile base fee plus the median priority fee).
- **A rollup's L1 data fee** comes from its own oracle, for a real-sized signed
  transaction.
- **The gas** comes from `contracts/snapshots/`, which equals a receipt's
  `gasUsed` on Anvil.
- **ETH was EUR 2,080.57** (CoinGecko).

One report is an anchor (190,407 gas) and its stamped copy (224,853 gas). A
revocation is 42,294 gas. These were the figures on the day of measurement.
Since delayed revocation (#95), an anchor and its copy take 416,675 gas
together (0.3% more) and a revocation takes 62,334: it writes a fresh storage
slot. Rerun the script for current figures.

| Chain | Base fee, median / p90 (gwei) | L1 data fee, anchor + copy | One report, median | One report, p90 | `finalized` trails the latest block |
| --- | --- | --- | --- | --- | --- |
| Ethereum mainnet | 0.042 / 0.056 | — | EUR 0.042 | EUR 0.054 | 14 min |
| Base | 0.005 / 0.005 | 1.6 × 10⁻⁹ ETH | EUR 0.005 | EUR 0.005 | 21 min |
| OP Mainnet | 0.0000004 / 0.0000004 | 2.6 × 10⁻⁹ ETH | EUR 0.0001 | EUR 0.0001 | 21 min |
| Arbitrum One | 0.020 / 0.020 | 9.3 × 10⁻⁹ ETH | EUR 0.017 | EUR 0.017 | 18 min |

**These are today's figures, and mainnet's move the most.** Mainnet gas is
unusually low at present. The same report costs:

| Mainnet base fee | One report (EUR, ETH at 2,080) |
| --- | --- |
| 1 gwei | 0.86 |
| 5 gwei | 4.32 |
| 20 gwei | 17.28 |
| 50 gwei | 43.20 |

The rollups are cheaper by one to three orders of magnitude, and their fees
move far less. Their L1 data fee follows Ethereum's blob fee, which is a
millionth of a euro today; a thousandfold rise would still cost under a cent.
Merkle batching (#64) would cut any chain's cost per report further: one
transaction anchors a whole batch.

**Finality is about the same everywhere: 15 to 20 minutes.** A rollup's block
is `finalized` once the Ethereum block holding its data is. So no candidate
anchors faster than mainnet, and the console waits about as long on each.

## Who else the record depends on

**Ethereum mainnet** depends on Ethereum alone:
- no operator;
- no upgrade key over the chain;
- many independent RPC providers and archive nodes;
- anyone can run a node that reads every record ever written.

**The three rollups** are Stage 1 optimistic rollups on L2BEAT. They add
parties, and they keep their data on Ethereum only for a while:

| | Base | OP Mainnet | Arbitrum One |
| --- | --- | --- | --- |
| Sequencer | a single sequencer, set by a Base multisig | a single sequencer, set by an Optimism Foundation safe | a single sequencer |
| If the sequencer censors or stops | force inclusion through L1, up to 12 h | force inclusion through L1, up to 12 h | force inclusion through L1, up to 1 day |
| Who can upgrade the system | a 2-of-2 of the Base Security Council (8/11) and a coordinator multisig (3/6) | a 2-of-2 of the Optimism Foundation and a Security Council (10/13) | the Arbitrum DAO, or a Security Council (9/12) |
| Upgrade delay | none | ordinary upgrades after a 7-day veto window; emergency upgrades instant | 17 days 8 h for ordinary upgrades; Security Council emergency actions instant |
| Data | blobs on Ethereum | blobs on Ethereum | blobs on Ethereum |

Source for the table: L2BEAT's project pages for
[Base](https://l2beat.com/scaling/projects/base),
[OP Mainnet](https://l2beat.com/scaling/projects/op-mainnet) and
[Arbitrum One](https://l2beat.com/scaling/projects/arbitrum), read 2026-10-25.

**Two consequences for an evidence registry.**

- **Reading an old record needs the rollup's own infrastructure.** Ethereum
  keeps blob data for about 18 days (4,096 epochs, per
  [EIP-4844](https://eips.ethereum.org/EIPS/eip-4844)). After that, a rollup
  record is read from the rollup's own nodes and RPC providers, or rebuilt from
  archives of old blobs that others choose to keep. If a rollup were wound
  down, its records would stay true but would become hard to read. A mainnet
  record stays readable from any Ethereum archive node.
- **An upgrade key exists over the chain itself.** Under its rules, a Security
  Council can change a rollup's contracts instantly in an emergency. That is
  not a reason to expect misuse; it is one more party a court or a regulator
  could ask about.

## Explorers and tooling

All four have an Etherscan-family explorer: etherscan.io, basescan.org,
optimistic.etherscan.io and arbiscan.io, plus their Sepolia counterparts. One
Etherscan API key covers them all; it picks the chain with `chainid`, per
[Etherscan's docs](https://docs.etherscan.io/etherscan-v2). The deploy script
verifies the contract's source with `forge verify-contract --chain <chain id>`.
viem, Foundry and every major RPC provider support all four.

## What is built

- **`src/lib/chain/networks.ts`** names all four, and each one's Sepolia
  testnet: `mainnet`, `base`, `optimism`, `arbitrum`, then `sepolia`,
  `base-sepolia`, `optimism-sepolia`, `arbitrum-sepolia`. Each reads
  `<NETWORK>_RPC_URL`, has its own `deployments/<network>.json`, and has an
  explorer link and a readable name. The worker, the verifier and the scripts
  take any of them through `ANCHOR_NETWORK` / `VERIFY_NETWORK`.
- **`scripts/deploy-registry.ts`** deploys to the testnets and refuses the
  production networks (`PRODUCTION_NETWORKS`) by name. Deploying to a testnet
  waits only on funded keys (#4).
- **Tested on Anvil** (`tests/integration/networks.test.ts`), with Base
  Sepolia's chain id:
  - the deploy script refuses `base`;
  - it deploys to `base-sepolia`;
  - the adapter anchors there and reaches finality through viem's OP Stack
    chain definition.

## Recommendation

**Ethereum mainnet**, with Merkle batching (#64) turned on if volume makes
cost matter.

- **What matters most is the first criterion.** The record must be readable,
  by anyone, for as long as the report is relied on. Mainnet is the only
  candidate where that needs nobody's continued service: no sequencer, no
  upgrade council, no blob archive.
- **The cost is small for an audit report even when fees rise.** It is about
  EUR 1 to 17 per report at 1 to 20 gwei, and cents at today's fees. Batching
  turns it into a fraction of that.
- **Mainnet is not slower to finality.**

**If cost per report must be near zero, Arbitrum One is the alternative.**
Its ordinary upgrades wait more than 17 days, the longest exit window of the
three, and its fees are cents.
- **The trade-off:** a sequencer operator and an upgrade council, and old
  records readable only while Arbitrum's infrastructure, or someone's archive,
  lasts.
- **A way to soften it:** a rollup choice pairs well with re-anchoring a
  periodic root on mainnet (the same mechanism as #65), which puts the
  long-lived copy back on Ethereum.

Whichever is chosen, the OpenTimestamps anchor (#66) gives every manifest a
second, independent timestamp on Bitcoin.

## The decision

- [ ] **The owner chooses the production chain.**

  When the choice is made:
  1. its testnet is deployed and rehearsed (after #4);
  2. `scripts/deploy-registry.ts` stops refusing that one network, in the
     same pull request that records this decision;
  3. the ROADMAP's Phase 6 exit gate counts it as signed off.
