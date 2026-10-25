/**
 * Settles a journal write the worker cannot settle by itself (#78): it is
 * INDETERMINATE, none of its transactions is mined or known to the node, and
 * the issuer's next nonce is still its own. Uses that nonce with a zero-value
 * transfer to the issuer, recorded in the audit log under the operator's name
 * before it is sent; once that transfer is final the worker marks the write
 * FAILED (NONCE_CONSUMED) and releases the issuer key.
 *
 *   npx tsx scripts/settle-write.ts <chainWriteId> --operator <approver email>
 *
 * Reads the issuer settings in scripts/issuer-env.ts. Refuses, by name,
 * anything but that one situation; never resends the write itself.
 */
import { releaseStuckNonce, ReleaseError } from '../src/lib/anchoring/settle';
import { issuerEnv, refuse } from './issuer-env';

async function main() {
  const [chainWriteId] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const operatorIndex = process.argv.indexOf('--operator');
  const operatorEmail = operatorIndex > 0 ? process.argv[operatorIndex + 1] : undefined;
  if (!chainWriteId || !operatorEmail) refuse('settle-write', 'usage: npx tsx scripts/settle-write.ts <chainWriteId> --operator <approver email>');

  const env = await issuerEnv('settle-write');
  try {
    const { txHash, nonce } = await releaseStuckNonce(env, { chainWriteId, operatorEmail });
    console.log(JSON.stringify({ level: 'info', message: 'nonce released; the worker settles the write once this transfer is final', chainWriteId, nonce, txHash }));
  } catch (error) {
    if (error instanceof ReleaseError) {
      console.error(JSON.stringify({ level: 'error', message: 'refused', code: error.code, detail: error.message }));
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await env.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ level: 'error', message: 'settle-write stopped', error: error instanceof Error ? error.name : typeof error }));
  process.exit(1);
});
