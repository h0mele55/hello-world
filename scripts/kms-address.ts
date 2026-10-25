/**
 * Prints the Ethereum address of a Cloud KMS key version, for the owner to
 * register as an issuer key (docs/runbooks/kms-key.md). It reads the public
 * key and signs nothing.
 *
 *   npx tsx scripts/kms-address.ts projects/…/locations/…/keyRings/…/cryptoKeys/…/cryptoKeyVersions/N
 *
 * Credentials are the host's (Application Default Credentials).
 */
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { createKmsAccount, KmsSignerError } from '../src/lib/chain/kms-account';

async function main() {
  const keyName = process.argv[2];
  if (!keyName) {
    console.error(JSON.stringify({ level: 'error', message: 'usage: npx tsx scripts/kms-address.ts <key version name>' }));
    process.exit(2);
  }
  const account = await createKmsAccount({ client: new KeyManagementServiceClient(), keyName });
  console.log(JSON.stringify({ level: 'info', keyName, address: account.address }));
}

main().catch((error) => {
  const detail = error instanceof KmsSignerError ? `${error.code}: ${error.message}` : error instanceof Error ? error.name : typeof error;
  console.error(JSON.stringify({ level: 'error', message: 'kms-address refused', detail }));
  process.exit(2);
});
