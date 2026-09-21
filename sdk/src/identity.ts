/**
 * Agent anonymity-set identity (Semaphore v4).
 *
 * This is the agent's PRIVATE-track identity: its commitment is the leaf inserted into the
 * risk-tier group when a compliance attestation is issued (via the `identityCommitment` schema
 * field). It is distinct from the agent's public ERC-8004 identity — see
 * docs/04-identity-and-privacy.md for the layering.
 *
 * The identity secret is a bearer credential: whoever holds it can produce membership proofs.
 * Store it like a signing key. If it leaks, the attestation should be revoked and the agent
 * re-attested with a fresh identity.
 */
import { Identity } from "@semaphore-protocol/identity";

/**
 * Creates a new Semaphore identity for an agent. Pass a stable secret (e.g. from a KMS) to
 * derive deterministically; omit it for a random identity.
 */
export function createAgentIdentity(secret?: string): Identity {
  return secret === undefined ? new Identity() : new Identity(secret);
}

/** The public commitment — the value that appears in the attestation and the on-chain group. */
export function getCommitment(identity: Identity): bigint {
  return identity.commitment;
}

export { Identity };
