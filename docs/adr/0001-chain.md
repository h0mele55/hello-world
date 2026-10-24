# 0001 — Ethereum Sepolia, behind a chain adapter

Status: accepted, 2026-10-24.

## Decision

Anchor on Ethereum Sepolia (chain id 11155111). Every chain call goes through a
`ChainAdapter` interface, so moving to another network is a new implementation
and a config change, not a rewrite.

## Why

ethereum.org names Sepolia "the recommended default testnet for application
development". It has the best explorer support (Etherscan) and is the network
every Ethereum L2 testnet settles to.

## Rejected

- Base Sepolia, Polygon Amoy: faster blocks and easier faucets, but Base
  Sepolia settles to Sepolia and shares its lifecycle.
- Bitcoin via OpenTimestamps: free and durable, but it cannot hold a version
  chain. Kept as the Phase 6 second anchor.

## Consequences

Testnets promise no durability and a Sepolia successor has been discussed, so
anchors are prototype evidence only (rule 9). Phase 6 adds re-anchoring.
