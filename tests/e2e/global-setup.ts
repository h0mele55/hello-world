import fs from 'node:fs';
import { createTestPki, pemOf } from '../helpers/test-pki';

/**
 * The app's server is started with SEAL_TRUST_ANCHORS naming this file
 * (playwright.config.ts), and /verify refuses to serve a verifier whose roots
 * file cannot be read or holds no certificate (#157). So it must hold a valid
 * root before any test opens a page: a throwaway one, which
 * tests/e2e/anchoring.spec.ts replaces with its stand-in provider's root.
 */
export default async function globalSetup() {
  const file = process.env.E2E_SEAL_ROOTS!;
  const pki = await createTestPki();
  fs.writeFileSync(file, pemOf(pki.rootDer));
}
