// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

/// @title AuditReportRegistry
/// @notice Records SHA-256 commitments to audit reports, chains each reissued
/// version to its predecessor, and answers "is this file registered, and what
/// is the latest version of its report?" in one read.
///
/// Only commitments live here: file hashes, salted manifest hashes, salted
/// opinion commitments and pseudonymous family ids. No client name, opinion
/// type or report text is ever stored (CLAUDE.md rule 1).
///
/// The contract is immutable: no proxy, no delegatecall, no payable function
/// and no external call. Ownership manages the issuer allowlist and may cancel
/// a revocation before it takes effect.
///
/// Revocation is delayed (#95). An issuer key asks; the revocation takes effect
/// `revocationDelay` seconds later, and until then only the owner can cancel
/// it. A stolen issuer key therefore cannot withdraw a firm's records at once:
/// the firm has the delay to notice and to have the owner cancel. Once in
/// effect, a revocation is terminal.
///
/// It also keeps each firm's audit-log heads (#94): the hash of the firm's
/// latest audit event, written nightly by its issuer key, so a database owner
/// who rewrites the log cannot also rewrite the record of what it was. A head
/// is a hash and nothing else; only the owner can void one, for a head a
/// stolen key wrote.
///
/// And it keeps re-anchor roots (#65): the Merkle root of every record another
/// deployment of this registry held at one finalized block, committed here by
/// the owner before that chain is shut down, so its records stay verifiable
/// through a proof against the root. Only the owner can record or void one.
contract AuditReportRegistry {
    enum Kind {
        ORIGINAL,
        DISTRIBUTION_COPY
    }

    struct Record {
        bytes32 familyId;
        bytes32 docHash;
        bytes32 manifestHash;
        bytes32 opinionCommitment;
        // The previous version for an ORIGINAL (zero for version 1), or the
        // original a DISTRIBUTION_COPY was stamped from.
        bytes32 parentId;
        // The next four pack into one slot (20 + 5 + 4 + 1 bytes).
        // uint40 holds block numbers past 10^12.
        address issuer;
        uint40 blockNumber;
        uint32 version;
        Kind kind;
    }

    /// @notice A revocation asked for by an issuer key: the reason's code and
    /// the time it takes effect. One slot.
    struct Revocation {
        uint8 reason;
        uint40 effectiveAt;
    }

    /// @notice What `getRecord` returns: the record, and its revocation as it
    /// stands at the block read.
    struct RecordView {
        bytes32 familyId;
        bytes32 docHash;
        bytes32 manifestHash;
        bytes32 opinionCommitment;
        bytes32 parentId;
        address issuer;
        uint40 blockNumber;
        uint32 version;
        Kind kind;
        // In effect at this block: asked for, and its time has come.
        bool revoked;
        // Non-zero once asked for, whether pending or in effect.
        uint8 revokeReason;
        // When it takes effect (Unix seconds), or zero when none was asked for.
        uint40 revokeEffectiveAt;
    }

    struct Issuer {
        bytes32 orgId;
        bool active;
    }

    /// @notice One audit-log head: the hash of a firm's latest audit event when
    /// it was written. Two slots.
    struct AuditHead {
        bytes32 head;
        address issuer;
        uint40 recordedAt;
        bool voided;
    }

    /// @notice A re-anchor root (#65): the Merkle root of the `count` records
    /// another deployment of this registry held at `sourceBlock`, recorded at
    /// `recordedBlock` of this chain. Three slots.
    struct ReanchorRoot {
        bytes32 root;
        // The next three pack into one slot (20 + 8 + 4 bytes).
        address sourceRegistry;
        uint64 sourceChainId;
        uint32 count;
        uint40 sourceBlock;
        uint40 recordedBlock;
        bool voided;
    }

    /// @notice The longest delay a deployment may set: past it, a firm could
    /// not withdraw a wrong report in any useful time.
    uint32 public constant MAX_REVOCATION_DELAY = 30 days;

    address public owner;
    address public pendingOwner;
    /// @notice Seconds between an issuer's revocation and its effect, fixed at
    /// deployment. Kept in storage, not as an immutable, so every deployment of
    /// this build has the same runtime bytecode (DEPLOYMENT_STALE checks it).
    // slither-disable-next-line immutable-states
    uint32 public revocationDelay;

    mapping(address issuer => Issuer) public issuers;
    mapping(bytes32 recordId => Record) private _records;
    /// @notice The record a file hash was anchored as, or zero.
    mapping(bytes32 docHash => bytes32 recordId) public recordOfDoc;
    /// @notice The newest ORIGINAL of a family, or zero for an unknown family.
    mapping(bytes32 familyId => bytes32 recordId) public latestOf;
    /// @notice The distribution copy of an ORIGINAL, or zero.
    mapping(bytes32 originalId => bytes32 copyId) public copyOf;
    mapping(bytes32 recordId => Revocation) private _revocations;
    mapping(bytes32 orgId => AuditHead[]) private _auditHeads;
    ReanchorRoot[] private _reanchorRoots;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event IssuerSet(address indexed issuer, bytes32 indexed orgId, bool active);
    event Anchored(
        bytes32 indexed recordId,
        bytes32 indexed familyId,
        bytes32 indexed docHash,
        uint32 version,
        Kind kind,
        bytes32 parentId,
        address issuer
    );
    event RevocationRequested(
        bytes32 indexed recordId, uint8 reasonCode, uint40 effectiveAt, address issuer
    );
    event RevocationCancelled(bytes32 indexed recordId, uint8 reasonCode, address by);
    event AuditHeadRecorded(
        bytes32 indexed orgId, uint256 indexed index, bytes32 head, address issuer
    );
    event AuditHeadVoided(bytes32 indexed orgId, uint256 indexed index, address by);
    event ReanchorRootRecorded(
        uint256 indexed index,
        bytes32 indexed root,
        uint64 sourceChainId,
        address sourceRegistry,
        uint40 sourceBlock,
        uint32 count
    );
    event ReanchorRootVoided(uint256 indexed index, address by);

    error NotOwner();
    error NotPendingOwner();
    error NotIssuer();
    error ZeroValue();
    error IssuerOrgImmutable(bytes32 currentOrgId);
    error DocAlreadyAnchored(bytes32 docHash, bytes32 recordId);
    error FamilyExists(bytes32 familyId);
    error UnknownFamily(bytes32 familyId);
    error NotFamilyIssuer(bytes32 familyId);
    error StaleParent(bytes32 given, bytes32 latest);
    error BadVersion(uint32 given, uint32 expected);
    error UnknownRecord(bytes32 recordId);
    error NotOriginal(bytes32 recordId);
    error CopyExists(bytes32 originalId, bytes32 copyId);
    error RevocationExists(bytes32 recordId, uint40 effectiveAt);
    error NoRevocation(bytes32 recordId);
    error RevocationInEffect(bytes32 recordId, uint40 effectiveAt);
    error DelayTooLong(uint32 given, uint32 max);
    error UnknownAuditHead(bytes32 orgId, uint256 index);
    error AuditHeadAlreadyVoided(bytes32 orgId, uint256 index);
    error ReanchorOfSelf();
    error UnknownReanchorRoot(uint256 index);
    error ReanchorRootAlreadyVoided(uint256 index);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param revocationDelay_ Seconds a revocation waits before it takes
    /// effect. Zero makes revocation immediate, for local test chains only;
    /// scripts/deploy-registry.ts refuses less than an hour anywhere else.
    constructor(address initialOwner, uint32 revocationDelay_) {
        if (initialOwner == address(0)) revert ZeroValue();
        if (revocationDelay_ > MAX_REVOCATION_DELAY) {
            revert DelayTooLong(revocationDelay_, MAX_REVOCATION_DELAY);
        }
        owner = initialOwner;
        revocationDelay = revocationDelay_;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    // ── Ownership (two-step, so a mistyped address cannot strand the registry) ──

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroValue();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ── Issuers ──

    /// @notice Adds, re-activates or deactivates an issuer key. A key belongs to
    /// one organisation for life: moving it to another org would let that org
    /// extend or revoke families it never anchored.
    function setIssuer(address issuer, bytes32 orgId, bool active) external onlyOwner {
        if (issuer == address(0) || orgId == bytes32(0)) revert ZeroValue();
        bytes32 current = issuers[issuer].orgId;
        if (current != bytes32(0) && current != orgId) revert IssuerOrgImmutable(current);
        issuers[issuer] = Issuer({orgId: orgId, active: active});
        emit IssuerSet(issuer, orgId, active);
    }

    // ── Writes ──

    /// @notice Anchors an ORIGINAL. Version 1 starts a family; version n+1 must
    /// name the family's current latest as its parent, so a stale or forked
    /// reissue reverts instead of creating a second "latest".
    function anchor(
        bytes32 familyId,
        uint32 version,
        bytes32 parentId,
        bytes32 docHash,
        bytes32 manifestHash,
        bytes32 opinionCommitment
    ) external returns (bytes32 recordId) {
        bytes32 orgId = _activeOrgOf(msg.sender);
        if (
            familyId == bytes32(0) || docHash == bytes32(0) || manifestHash == bytes32(0)
                || opinionCommitment == bytes32(0)
        ) revert ZeroValue();
        _requireUnusedDoc(docHash);

        bytes32 latest = latestOf[familyId];
        if (version == 1) {
            if (latest != bytes32(0)) revert FamilyExists(familyId);
            if (parentId != bytes32(0)) revert StaleParent(parentId, bytes32(0));
        } else {
            if (latest == bytes32(0)) revert UnknownFamily(familyId);
            if (familyOrg(familyId) != orgId) revert NotFamilyIssuer(familyId);
            if (parentId != latest) revert StaleParent(parentId, latest);
            uint32 expected = _records[latest].version + 1;
            if (version != expected) revert BadVersion(version, expected);
        }

        recordId = recordIdFor(familyId, version, Kind.ORIGINAL);
        _records[recordId] = Record({
            familyId: familyId,
            docHash: docHash,
            manifestHash: manifestHash,
            opinionCommitment: opinionCommitment,
            parentId: parentId,
            issuer: msg.sender,
            // forge-lint: disable-next-line(unsafe-typecast)
            blockNumber: uint40(block.number),
            version: version,
            kind: Kind.ORIGINAL
        });
        recordOfDoc[docHash] = recordId;
        latestOf[familyId] = recordId;
        emit Anchored(recordId, familyId, docHash, version, Kind.ORIGINAL, parentId, msg.sender);
    }

    /// @notice Anchors the stamped copy of an ORIGINAL: the same report with its
    /// own anchor details written into the metadata, hence a different file
    /// hash. One copy per original; it never becomes a family's latest.
    function anchorDistributionCopy(bytes32 originalId, bytes32 docHash)
        external
        returns (bytes32 recordId)
    {
        bytes32 orgId = _activeOrgOf(msg.sender);
        if (docHash == bytes32(0)) revert ZeroValue();
        Record storage original = _records[originalId];
        if (original.docHash == bytes32(0)) revert UnknownRecord(originalId);
        if (original.kind != Kind.ORIGINAL) revert NotOriginal(originalId);
        if (familyOrg(original.familyId) != orgId) revert NotFamilyIssuer(original.familyId);
        // A copy of an original being withdrawn, or withdrawn, is never anchored.
        Revocation memory revocation = _revocations[originalId];
        if (revocation.reason != 0) revert RevocationExists(originalId, revocation.effectiveAt);
        bytes32 existing = copyOf[originalId];
        if (existing != bytes32(0)) revert CopyExists(originalId, existing);
        _requireUnusedDoc(docHash);

        recordId = recordIdFor(original.familyId, original.version, Kind.DISTRIBUTION_COPY);
        _records[recordId] = Record({
            familyId: original.familyId,
            docHash: docHash,
            manifestHash: original.manifestHash,
            opinionCommitment: original.opinionCommitment,
            parentId: originalId,
            issuer: msg.sender,
            // forge-lint: disable-next-line(unsafe-typecast)
            blockNumber: uint40(block.number),
            version: original.version,
            kind: Kind.DISTRIBUTION_COPY
        });
        recordOfDoc[docHash] = recordId;
        copyOf[originalId] = recordId;
        emit Anchored(
            recordId,
            original.familyId,
            docHash,
            original.version,
            Kind.DISTRIBUTION_COPY,
            originalId,
            msg.sender
        );
    }

    /// @notice Asks to withdraw a record. It takes effect `revocationDelay`
    /// seconds from now; until then the owner may cancel it. Once in effect it
    /// is terminal. One revocation per record: a second ask reverts, pending or
    /// not, so a stolen key cannot replace a genuine reason with its own.
    function revoke(bytes32 recordId, uint8 reasonCode) external returns (uint40 effectiveAt) {
        bytes32 orgId = _activeOrgOf(msg.sender);
        if (reasonCode == 0) revert ZeroValue();
        Record storage record = _records[recordId];
        if (record.docHash == bytes32(0)) revert UnknownRecord(recordId);
        if (familyOrg(record.familyId) != orgId) revert NotFamilyIssuer(record.familyId);
        Revocation memory existing = _revocations[recordId];
        if (existing.reason != 0) revert RevocationExists(recordId, existing.effectiveAt);
        // forge-lint: disable-next-line(unsafe-typecast)
        effectiveAt = uint40(block.timestamp) + revocationDelay;
        _revocations[recordId] = Revocation({reason: reasonCode, effectiveAt: effectiveAt});
        emit RevocationRequested(recordId, reasonCode, effectiveAt, msg.sender);
    }

    /// @notice Cancels a revocation that has not yet taken effect. The owner's
    /// act only (the Safe, #67), never an issuer key's, so a stolen issuer key
    /// can neither revoke at once nor cancel a genuine revocation. The record
    /// may be revoked again later.
    // slither-disable-next-line timestamp
    function cancelRevocation(bytes32 recordId) external onlyOwner {
        Revocation memory revocation = _revocations[recordId];
        if (revocation.reason == 0) revert NoRevocation(recordId);
        // A validator can shift a block's time by seconds; the delay is hours.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= revocation.effectiveAt) {
            revert RevocationInEffect(recordId, revocation.effectiveAt);
        }
        delete _revocations[recordId];
        emit RevocationCancelled(recordId, revocation.reason, msg.sender);
    }

    // ── Audit-log heads (#94) ──

    /// @notice Appends the hash of the caller's firm's latest audit event. The
    /// firm's nightly check holds its database to every head not voided: each
    /// must still be the hash of one of its events. Nothing but the hash is
    /// kept, not even the event's number, so the firm's activity stays private.
    function recordAuditHead(bytes32 head) external returns (uint256 index) {
        bytes32 orgId = _activeOrgOf(msg.sender);
        if (head == bytes32(0)) revert ZeroValue();
        index = _auditHeads[orgId].length;
        _auditHeads[orgId].push(
            AuditHead({
                head: head,
                issuer: msg.sender,
                // forge-lint: disable-next-line(unsafe-typecast)
                recordedAt: uint40(block.timestamp),
                voided: false
            })
        );
        emit AuditHeadRecorded(orgId, index, head, msg.sender);
    }

    /// @notice Voids a head, so the firm's check no longer holds its log to it.
    /// The owner's act only: for a head a stolen issuer key wrote, never one
    /// the firm's own log contains. Terminal: a voided head stays voided.
    function voidAuditHead(bytes32 orgId, uint256 index) external onlyOwner {
        if (index >= _auditHeads[orgId].length) revert UnknownAuditHead(orgId, index);
        AuditHead storage entry = _auditHeads[orgId][index];
        if (entry.voided) revert AuditHeadAlreadyVoided(orgId, index);
        entry.voided = true;
        emit AuditHeadVoided(orgId, index, msg.sender);
    }

    // ── Re-anchoring (#65) ──

    /// @notice Commits the Merkle root of every record another deployment of
    /// this registry held at `sourceBlock`, so they stay verifiable after that
    /// chain is shut down (docs/runbooks/sepolia-sunset.md). The owner's act
    /// only: a root vouches for a whole deployment's history, and a stolen
    /// issuer key must never be able to vouch for records that did not exist.
    /// `count` is how many records are under the root, so a verifier holding
    /// them can tell the whole set from part of it.
    function recordReanchorRoot(
        bytes32 root,
        uint64 sourceChainId,
        address sourceRegistry,
        uint40 sourceBlock,
        uint32 count
    ) external onlyOwner returns (uint256 index) {
        if (
            root == bytes32(0) || sourceChainId == 0 || sourceRegistry == address(0)
                || sourceBlock == 0 || count == 0
        ) revert ZeroValue();
        // A deployment holds its own records already; a root of them proves nothing.
        if (sourceChainId == block.chainid && sourceRegistry == address(this)) {
            revert ReanchorOfSelf();
        }
        index = _reanchorRoots.length;
        _reanchorRoots.push(
            ReanchorRoot({
                root: root,
                sourceRegistry: sourceRegistry,
                sourceChainId: sourceChainId,
                count: count,
                sourceBlock: sourceBlock,
                // forge-lint: disable-next-line(unsafe-typecast)
                recordedBlock: uint40(block.number),
                voided: false
            })
        );
        emit ReanchorRootRecorded(index, root, sourceChainId, sourceRegistry, sourceBlock, count);
    }

    /// @notice Voids a root, so verifiers no longer accept proofs against it:
    /// for a root recorded in error. Terminal; a corrected root is recorded anew.
    function voidReanchorRoot(uint256 index) external onlyOwner {
        if (index >= _reanchorRoots.length) revert UnknownReanchorRoot(index);
        ReanchorRoot storage entry = _reanchorRoots[index];
        if (entry.voided) revert ReanchorRootAlreadyVoided(index);
        entry.voided = true;
        emit ReanchorRootVoided(index, msg.sender);
    }

    // ── Reads ──

    /// @notice How many re-anchor roots there are, voided ones included.
    function reanchorRootCount() external view returns (uint256) {
        return _reanchorRoots.length;
    }

    /// @notice Up to `limit` re-anchor roots from `start`, in the order
    /// recorded; fewer at the end, none past it.
    function reanchorRoots(uint256 start, uint256 limit)
        external
        view
        returns (ReanchorRoot[] memory page)
    {
        if (start >= _reanchorRoots.length) return page;
        uint256 end = limit > _reanchorRoots.length - start ? _reanchorRoots.length : start + limit;
        page = new ReanchorRoot[](end - start);
        for (uint256 i = start; i < end; ++i) {
            page[i - start] = _reanchorRoots[i];
        }
    }

    /// @notice How many heads a firm has, voided ones included.
    function auditHeadCount(bytes32 orgId) external view returns (uint256) {
        return _auditHeads[orgId].length;
    }

    /// @notice Up to `limit` of a firm's heads from `start`, in the order
    /// written; fewer at the end, none past it. Read a page at a time.
    function auditHeads(bytes32 orgId, uint256 start, uint256 limit)
        external
        view
        returns (AuditHead[] memory page)
    {
        AuditHead[] storage all = _auditHeads[orgId];
        if (start >= all.length) return page;
        uint256 end = limit > all.length - start ? all.length : start + limit;
        page = new AuditHead[](end - start);
        for (uint256 i = start; i < end; ++i) {
            page[i - start] = all[i];
        }
    }

    /// @notice The issuer organisation a family belongs to, or zero for an
    /// unknown family. Derived rather than stored: every record in a family was
    /// anchored by a key of the org that anchored version 1, and a key's org can
    /// never change (setIssuer refuses it), so the latest record's issuer names
    /// the org. Deriving it saves a storage write on every new family.
    function familyOrg(bytes32 familyId) public view returns (bytes32) {
        bytes32 latest = latestOf[familyId];
        if (latest == bytes32(0)) return bytes32(0);
        return issuers[_records[latest].issuer].orgId;
    }

    /// @notice The record and its revocation as they stand at this block, or
    /// an all-zero view for an unknown id. `revoked` is computed from the
    /// block's time, so a revocation takes effect without a second transaction.
    // slither-disable-next-line timestamp
    function getRecord(bytes32 recordId) external view returns (RecordView memory view_) {
        Record storage record = _records[recordId];
        Revocation memory revocation = _revocations[recordId];
        view_ = RecordView({
            familyId: record.familyId,
            docHash: record.docHash,
            manifestHash: record.manifestHash,
            opinionCommitment: record.opinionCommitment,
            parentId: record.parentId,
            issuer: record.issuer,
            blockNumber: record.blockNumber,
            version: record.version,
            kind: record.kind,
            // forge-lint: disable-next-line(block-timestamp)
            revoked: revocation.reason != 0 && block.timestamp >= revocation.effectiveAt,
            revokeReason: revocation.reason,
            revokeEffectiveAt: revocation.effectiveAt
        });
    }

    /// @notice Deterministic record id: the chain and this contract are part of
    /// it, so the same family and version on another deployment never collide.
    function recordIdFor(bytes32 familyId, uint32 version, Kind kind)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(this), familyId, version, kind));
    }

    // ── Internals ──

    function _activeOrgOf(address account) private view returns (bytes32 orgId) {
        Issuer memory issuer = issuers[account];
        if (!issuer.active) revert NotIssuer();
        return issuer.orgId;
    }

    function _requireUnusedDoc(bytes32 docHash) private view {
        bytes32 existing = recordOfDoc[docHash];
        if (existing != bytes32(0)) revert DocAlreadyAnchored(docHash, existing);
    }
}
