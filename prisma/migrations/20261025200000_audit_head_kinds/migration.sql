-- #94: the audit log's head is written on chain through the journal. A new
-- enum value cannot be used in the transaction that adds it, so the journal's
-- constraints that name it are in the next migration.
ALTER TYPE "ChainWriteKind" ADD VALUE 'AUDIT_HEAD';
ALTER TYPE "UnjournaledKind" ADD VALUE 'AUDIT_HEAD';
