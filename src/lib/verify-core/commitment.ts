import { concat, sha256, stringToBytes, type Hex } from 'viem';
import { normaliseText } from '../opinion/normalise';
import { OPINION_TYPES, type OpinionType } from '../opinion/types';

/**
 * The hashes a verifier recomputes, isomorphic (browser and Node): the file's
 * docHash and the opinion commitment. The server's src/lib/commitments.ts
 * re-exports the commitment from here, so there is one implementation.
 */

export const SALT_BYTES = 32;

export class CommitmentInputError extends Error {
  constructor(
    readonly code:
      | 'FAMILY_SECRET_TOO_SHORT'
      | 'FAMILY_KEY_INVALID'
      | 'SALT_INVALID'
      | 'OPINION_TYPE_INVALID'
      | 'OPINION_TEXT_EMPTY'
      | 'OPINION_TEXT_NOT_NORMALISED',
    message: string,
  ) {
    super(message);
    this.name = 'CommitmentInputError';
  }
}

/** SHA-256 of the exact file bytes. */
export function docHashOf(fileBytes: Uint8Array): Hex {
  return sha256(fileBytes);
}

const UNIT_SEPARATOR = new Uint8Array([0x1f]);

/**
 * opinionCommitment = SHA-256(salt ‖ utf8(type) ‖ 0x1F ‖ utf8(text)).
 * The salt has a fixed length and no type contains 0x1F, so the encoding is
 * unambiguous. The text must already be normalised (normaliser v1): what is
 * committed is exactly what the person confirmed, with no hidden step.
 */
export function opinionCommitmentOf(input: { salt: Uint8Array; type: OpinionType; text: string }): Hex {
  if (input.salt.length !== SALT_BYTES) throw new CommitmentInputError('SALT_INVALID', `the salt must be ${SALT_BYTES} bytes`);
  if (!OPINION_TYPES.includes(input.type)) throw new CommitmentInputError('OPINION_TYPE_INVALID', 'unknown opinion type');
  if (input.text === '') throw new CommitmentInputError('OPINION_TEXT_EMPTY', 'the opinion text is empty');
  if (normaliseText(input.text) !== input.text) {
    throw new CommitmentInputError('OPINION_TEXT_NOT_NORMALISED', 'normalise the opinion text before committing to it');
  }
  return sha256(concat([input.salt, stringToBytes(input.type), UNIT_SEPARATOR, stringToBytes(input.text)]));
}
