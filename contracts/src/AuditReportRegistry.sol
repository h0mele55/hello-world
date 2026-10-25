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
/// and no external call. Ownership only manages the issuer allowlist.
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
        // The next five pack into one slot (20 + 5 + 4 + 1 + 1 + 1 bytes).
        // uint40 holds block numbers past 10^12.
        address issuer;
        uint40 blockNumber;
        uint32 version;
        Kind kind;
        bool revoked;
        uint8 revokeReason;
    }

    struct Issuer {
        bytes32 orgId;
        bool active;
    }

    address public owner;
    address public pendingOwner;

    mapping(address issuer => Issuer) public issuers;
    mapping(bytes32 recordId => Record) private _records;
    /// @notice The record a file hash was anchored as, or zero.
    mapping(bytes32 docHash => bytes32 recordId) public recordOfDoc;
    /// @notice The newest ORIGINAL of a family, or zero for an unknown family.
    mapping(bytes32 familyId => bytes32 recordId) public latestOf;
    /// @notice The distribution copy of an ORIGINAL, or zero.
    mapping(bytes32 originalId => bytes32 copyId) public copyOf;

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
    event Revoked(bytes32 indexed recordId, uint8 reasonCode, address issuer);

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
    error RecordRevoked(bytes32 recordId);
    error AlreadyRevoked(bytes32 recordId);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroValue();
        owner = initialOwner;
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
            kind: Kind.ORIGINAL,
            revoked: false,
            revokeReason: 0
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
        if (original.revoked) revert RecordRevoked(originalId);
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
            kind: Kind.DISTRIBUTION_COPY,
            revoked: false,
            revokeReason: 0
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

    /// @notice Withdraws a record. Terminal: nothing un-revokes it.
    function revoke(bytes32 recordId, uint8 reasonCode) external {
        bytes32 orgId = _activeOrgOf(msg.sender);
        if (reasonCode == 0) revert ZeroValue();
        Record storage record = _records[recordId];
        if (record.docHash == bytes32(0)) revert UnknownRecord(recordId);
        if (familyOrg(record.familyId) != orgId) revert NotFamilyIssuer(record.familyId);
        if (record.revoked) revert AlreadyRevoked(recordId);
        record.revoked = true;
        record.revokeReason = reasonCode;
        emit Revoked(recordId, reasonCode, msg.sender);
    }

    // ── Reads ──

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

    /// @notice The record, or an all-zero record for an unknown id.
    function getRecord(bytes32 recordId) external view returns (Record memory) {
        return _records[recordId];
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
