/**
 * The seal's two services (#70), provider-neutral: a qualified trust service
 * provider signs a hash with the firm's seal key, and a timestamping
 * authority stamps a hash with the time. Neither ever sees the document:
 * each is handed a SHA-256 digest and nothing else.
 */

export interface SealSigner {
  /** The seal certificate first, then the certificates that issued it, as DER. */
  certificates(): Promise<Uint8Array[]>;
  /**
   * Signs a SHA-256 digest with the seal key: an RSA PKCS #1 v1.5 signature,
   * or an ECDSA signature as a DER Ecdsa-Sig-Value. Which one is the seal
   * certificate's key's to say, and the answer is checked against it.
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
  /** The provider refused, or its answer is not what was asked for: a person looks. */
  | 'SIGNER_REFUSED'
  | 'TIMESTAMP_REFUSED'
  /** The provider did not answer, or answered 429 or 5xx: tried again on a later pass. */
  | 'SIGNER_UNAVAILABLE'
  | 'TIMESTAMP_UNAVAILABLE'
  /** A certificate's status could not be fetched (#119): its responder did not answer, or answered 429 or 5xx; tried again later. */
  | 'REVOCATION_UNAVAILABLE'
  /** A certificate's status, fetched or carried in the file, does not check: unsigned, signed by someone else, about another certificate, not current, or unknown. */
  | 'REVOCATION_REFUSED'
  /** A certificate the seal relies on is revoked. */
  | 'CERTIFICATE_REVOKED'
  /** A certificate names neither an OCSP responder nor a CRL, so its status cannot be carried. */
  | 'NO_REVOCATION_SOURCE'
  /** A check of a sealed file failed; the message says which. */
  | 'NO_SEAL'
  | 'NOT_WHOLE_FILE'
  | 'MALFORMED'
  | 'DIGEST_MISMATCH'
  | 'BAD_SIGNATURE'
  | 'WRONG_CERTIFICATE'
  | 'UNTRUSTED'
  | 'BAD_TIMESTAMP';

/** Whether a seal that failed with this code may succeed if simply tried again later. */
export const sealMayRetry = (code: SealErrorCode) => code === 'SIGNER_UNAVAILABLE' || code === 'TIMESTAMP_UNAVAILABLE' || code === 'REVOCATION_UNAVAILABLE';
