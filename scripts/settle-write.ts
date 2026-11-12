/**
 * Settles a journal write the worker cannot settle by itself.
 *
 * A write whose transaction is lost (#78): it is INDETERMINATE, none of its
 * transactions is mined or known to the node, and the issuer's next nonce is
 * still its own. Uses that nonce with a zero-value transfer to the issuer,
 * recorded in the audit log before it is sent; once that transfer is final the
 * worker marks the write FAILED (NONCE_CONSUMED) and releases the issuer key.
 *
 *   npx tsx scripts/settle-write.ts <chainWriteId> --operator <approver email>
 *
 * A write whose record does not match it (#140): its transaction is final but
 * the record is not what it should have written, so the worker holds it
 * (RECORD_MISMATCH) and the key with it. Once an approver has looked at it
 * (docs/runbooks/stuck-writes.md), this releases it: the worker reads it again
 * on both endpoints and, if it still does not match, fails it
 * (RECORD_MISMATCH_RESOLVED), keeping its nonce. Needs only DATABASE_URL.
 *
 *   npx tsx scripts/settle-write.ts <chainWriteId> --operator <approver email> --release-mismatch
 *
 * The operator is named, not signed in: the audit log records the name given
 * here as named at the command line. Refuses, by name, anything but those two
 * situations; never resends the write itself.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { releaseRecordMismatch, releaseStuckNonce, ReleaseError } from '../src/lib/anchoring/settle';
import { issuerEnv, refuse, requireEnv } from './issuer-env';

const USAGE = 'usage: npx tsx scripts/settle-write.ts <chainWriteId> --operator <approver email> [--release-mismatch]';

function report(error: unknown): void {
  if (error instanceof ReleaseError) {
    console.error(JSON.stringify({ level: 'error', message: 'refused', code: error.code, detail: error.message }));
    process.exitCode = 1;
    return;
  }
  throw error;
}

async function main() {
  const [chainWriteId] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--operator');
  const operatorIndex = process.argv.indexOf('--operator');
  const operatorEmail = operatorIndex > 0 ? process.argv[operatorIndex + 1] : undefined;
  if (!chainWriteId || !operatorEmail) refuse('settle-write', USAGE);

  if (process.argv.includes('--release-mismatch')) {
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: requireEnv('settle-write', 'DATABASE_URL') }) });
    try {
      await releaseRecordMismatch(prisma, { chainWriteId, operatorEmail });
      console.log(JSON.stringify({ level: 'info', message: 'released; the worker reads the write again and fails it if its record still does not match', chainWriteId }));
    } catch (error) {
      report(error);
    } finally {
      await prisma.$disconnect();
    }
    return;
  }

  const env = await issuerEnv('settle-write');
  try {
    const { txHash, nonce } = await releaseStuckNonce(env, { chainWriteId, operatorEmail });
    console.log(JSON.stringify({ level: 'info', message: 'nonce released; the worker settles the write once this transfer is final', chainWriteId, nonce, txHash }));
  } catch (error) {
    report(error);
  } finally {
    await env.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ level: 'error', message: 'settle-write stopped', error: error instanceof Error ? error.name : typeof error }));
  process.exit(1);
});
