/**
 * PoCA SDK — Proof of Compliant Agenthood.
 *
 * Public track: read and check compliance attestations on the EAS predeploy (`attestation.ts`).
 * Private track: prove membership of a risk-tier compliance set in zero knowledge (`proof.ts`).
 *
 * PoCA is an independent open-source project, not affiliated with or endorsed by IMDA, the
 * AI Verify Foundation, or the Government of Singapore.
 */
export * from "./constants.js";
export * from "./identity.js";
export * from "./attestation.js";
export * from "./proof.js";
export { Group } from "@semaphore-protocol/group";
