/**
 * The sealing contexts of a user's TOTP secrets. Shared by src/lib/mfa.ts and
 * prisma/seed.ts (which cannot import server-only modules), so the two cannot
 * drift apart: a secret sealed under one context does not open under another.
 */
export const totpSecretContext = (userId: string) => `User:${userId}:totpSecret`;
export const totpPendingContext = (userId: string) => `User:${userId}:totpPendingSecret`;
