/**
 * Everything a verifier needs, isomorphic (browser and Node, no server
 * imports): hashing, the opinion locator and normaliser, the opinion
 * commitment, reading a PDF's lines and stamp, the two-endpoint registry view
 * and the verdict. tests/unit/verify-core-imports.test.ts holds the boundary.
 */
export { docHashOf, opinionCommitmentOf, SALT_BYTES } from './commitment';
export { readDocument, VERIFY_LIMITS, type DocumentRead, type PdfjsLike, type ReadDocument } from './document';
export { CannotVerify, clientsFor, openRegistryView, type CannotVerifyReason, type RegistryView, type VerifierConfig } from './registry-view';
export { MAX_FILE_BYTES, summariseRecord, verifyFile, type RecordSummary, type Verdict, type VerdictKind } from './verdict';
export { locateOpinion, type LocateResult } from '../opinion/locate';
export { dropRunningLines, joinLines, normaliseText, NORMALISER_VERSION } from '../opinion/normalise';
export { OPINION_TYPES, type OpinionType } from '../opinion/types';
export { readStamp, type StampFields, type StampReading } from '../stamp-fields';
