/**
 * How long each background job may go quiet before the console and the
 * monitor (src/lib/monitor.ts) call it stopped. One place, so both agree;
 * importable by scripts, unlike the console's server-only modules.
 */

/** The audit-chain check runs nightly. */
export const AUDIT_CHECK_STALE_MS = 36 * 60 * 60 * 1000;
/** The registry watch runs every ten minutes. */
export const WATCH_STALE_MS = 2 * 60 * 60 * 1000;
/** The worker checks the issuer key's balance on every pass, every 15 s by default. */
export const WORKER_STALE_MS = 10 * 60 * 1000;
