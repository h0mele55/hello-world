/**
 * Every refusal the chain layer raises carries a stable `code`, so callers
 * (the Phase 3 journal, the Phase 4 verifier) branch on a name, not on a
 * message. CLAUDE.md rule 7: fail closed, with a named reason.
 */
export class ChainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = new.target.name;
  }
}

/** The RPC endpoint is on a different chain than the deployment names. */
export class ChainMismatchError extends ChainError {
  constructor(expected: number, actual: number) {
    super('CHAIN_MISMATCH', `Expected chain ${expected}, the RPC endpoint reports ${actual}`);
  }
}

/** The code at the registry address is not the contract this build expects. */
export class BytecodeMismatchError extends ChainError {
  constructor(address: string) {
    super('BYTECODE_MISMATCH', `The code at ${address} is not the expected AuditReportRegistry build`);
  }
}

/** No deployment file, or one that does not describe this build. */
export class DeploymentError extends ChainError {
  constructor(code: 'DEPLOYMENT_MISSING' | 'DEPLOYMENT_INVALID' | 'DEPLOYMENT_STALE', message: string) {
    super(code, message);
  }
}

/** The transaction was mined but reverted. */
export class TransactionRevertedError extends ChainError {
  constructor(txHash: string) {
    super('TX_REVERTED', `Transaction ${txHash} reverted`);
  }
}

/** The transaction's block did not reach `finalized` before the deadline. */
export class NotFinalError extends ChainError {
  constructor(txHash: string) {
    super('NOT_FINAL', `Transaction ${txHash} was not finalized before the deadline`);
  }
}

/** The transaction left the chain after it was first seen in a block. */
export class TransactionDroppedError extends ChainError {
  constructor(txHash: string) {
    super('TX_DROPPED', `Transaction ${txHash} is no longer on the chain`);
  }
}

/** The contract refused the call; `errorName` is its custom error. */
export class RegistryRevertError extends ChainError {
  readonly errorName: string;
  readonly args: readonly unknown[];

  constructor(errorName: string, args: readonly unknown[]) {
    super('REGISTRY_REVERT', `AuditReportRegistry refused the call: ${errorName}`);
    this.errorName = errorName;
    this.args = args;
  }
}
