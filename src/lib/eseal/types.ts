/**
 * The seal's two services (#70), provider-neutral: a qualified trust service
 * provider signs a hash with the firm's seal key, and a timestamping
 * authority stamps a hash with the time. Neither ever sees the document:
 * each is handed a SHA-256 digest and nothing else.
 */

/** The signature schemes a seal key may use. */
export type SealAlgorithm = 'RSA-PKCS1-SHA256' | 'ECDSA-SHA256';

export interface SealSigner {
  readonly algorithm: SealAlgorithm;
  /** The seal certificate first, then the certificates that issued it, as DER. */
  certificates(): Promise<Uint8Array[]>;
  /**
   * Signs a SHA-256 digest with the seal key: an RSA PKCS #1 v1.5 signature,
   * or an ECDSA signature as a DER Ecdsa-Sig-Value.
   */
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
}

export interface Timestamper {
  /** An RFC 3161 TimeStampToken (a DER ContentInfo) over a SHA-256 digest. */
  timestamp(digest: Uint8Array): Promise<Uint8Array>;
}

export class SealError extends Error {
  readonly code: SealErrorCode;
  constructor(code: SealErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'SealError';
  }
}

export type SealErrorCode =
  /** The PDF could not be opened, or already carries a signature. */
  | 'PDF_REFUSED'
  /** The signature and its timestamp do not fit the space reserved for them. */
  | 'TOO_LARGE'
  /** The provider's answer is not what was asked for. */
  | 'SIGNER_REFUSED'
  | 'TIMESTAMP_REFUSED'
  /** A check of a sealed file failed; the message says which. */
  | 'NO_SEAL'
  | 'NOT_WHOLE_FILE'
  | 'MALFORMED'
  | 'DIGEST_MISMATCH'
  | 'BAD_SIGNATURE'
  | 'WRONG_CERTIFICATE'
  | 'UNTRUSTED'
  | 'BAD_TIMESTAMP';
