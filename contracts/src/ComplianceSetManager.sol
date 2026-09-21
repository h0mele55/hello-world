// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

import {IComplianceSetManager} from "./interfaces/IComplianceSetManager.sol";

/// @title ComplianceSetManager
/// @notice Owns the private track's state: one Semaphore v4 group per risk tier. Membership is a
///         pure function of attestation lifecycle — insertion on a gated attestation, two-phase
///         removal on revocation.
/// @dev Two-phase removal: Semaphore's `removeMember` needs the leaf's LeanIMT sibling path, which
///      cannot be computed on-chain inside an EAS revoke callback. `onRevoked` therefore only marks
///      the removal; anyone (in practice a keeper watching `RemovalRequired`) finalizes it with
///      siblings computed off-chain from the public member list. Removal state is keyed by
///      attestation UID — never by commitment alone — because the same Semaphore identity may back
///      attestations in different tiers, and a commitment-keyed flag would let a third party remove
///      a membership whose attestation was never revoked.
contract ComplianceSetManager is IComplianceSetManager, Ownable {
    ISemaphore public immutable SEMAPHORE;

    /// @notice The only address allowed to drive membership (the ComplianceResolver).
    address public resolver;

    mapping(uint8 riskTier => uint256 groupId) internal _groupIds;
    mapping(uint8 riskTier => bool created) internal _tierExists;

    /// @notice Attestation UID → the Semaphore identity commitment it inserted (0 = unknown UID).
    mapping(bytes32 uid => uint256 identityCommitment) public commitmentOf;
    /// @notice Attestation UID → the risk tier it was attested under.
    mapping(bytes32 uid => uint8 riskTier) public tierOf;
    /// @notice Attestation UID → revoked but not yet removed from its group.
    mapping(bytes32 uid => bool pending) public removalPending;

    event ResolverUpdated(address indexed resolver);
    event TierGroupCreated(uint8 indexed riskTier, uint256 indexed groupId);
    event MemberRegistered(bytes32 indexed uid, uint8 indexed riskTier, uint256 identityCommitment);
    event RemovalRequired(bytes32 indexed uid, uint8 indexed riskTier, uint256 identityCommitment);
    event RemovalFinalized(bytes32 indexed uid, uint8 indexed riskTier, uint256 identityCommitment);

    error OnlyResolver();
    error TierAlreadyExists(uint8 riskTier);
    error TierUnknown(uint8 riskTier);
    error InvalidCommitment();
    error UidAlreadyRegistered(bytes32 uid);
    error UnknownUid(bytes32 uid);
    error RemovalNotPending(bytes32 uid);

    modifier onlyResolver() {
        if (msg.sender != resolver) {
            revert OnlyResolver();
        }
        _;
    }

    constructor(ISemaphore semaphore, address initialOwner) Ownable(initialOwner) {
        SEMAPHORE = semaphore;
    }

    /// @notice Wires the resolver. Must be called before any attestation can succeed.
    function setResolver(address newResolver) external onlyOwner {
        resolver = newResolver;
        emit ResolverUpdated(newResolver);
    }

    /// @notice Creates the Semaphore group for a risk tier, with this contract as group admin.
    function createTierGroup(uint8 riskTier) external onlyOwner returns (uint256 groupId) {
        if (_tierExists[riskTier]) {
            revert TierAlreadyExists(riskTier);
        }

        groupId = SEMAPHORE.createGroup(address(this));
        _groupIds[riskTier] = groupId;
        _tierExists[riskTier] = true;

        emit TierGroupCreated(riskTier, groupId);
    }

    /// @inheritdoc IComplianceSetManager
    /// @dev Reverts (failing the attestation) on: unknown tier, zero commitment, reused UID, or a
    ///      commitment already present in the tier group (Semaphore's LeanIMT enforces unique
    ///      leaves — re-attestation therefore requires either a fresh Semaphore identity or prior
    ///      removal of the old membership).
    function onAttested(bytes32 uid, uint256 identityCommitment, uint8 riskTier) external onlyResolver {
        if (!_tierExists[riskTier]) {
            revert TierUnknown(riskTier);
        }
        if (identityCommitment == 0) {
            revert InvalidCommitment();
        }
        if (commitmentOf[uid] != 0) {
            revert UidAlreadyRegistered(uid);
        }

        commitmentOf[uid] = identityCommitment;
        tierOf[uid] = riskTier;

        SEMAPHORE.addMember(_groupIds[riskTier], identityCommitment);

        emit MemberRegistered(uid, riskTier, identityCommitment);
    }

    /// @inheritdoc IComplianceSetManager
    function onRevoked(bytes32 uid) external onlyResolver {
        uint256 identityCommitment = commitmentOf[uid];
        if (identityCommitment == 0) {
            revert UnknownUid(uid);
        }

        removalPending[uid] = true;

        emit RemovalRequired(uid, tierOf[uid], identityCommitment);
    }

    /// @notice Executes a pending removal. Permissionless: liveness must not depend on the owner.
    /// @param uid The revoked attestation whose membership is being removed.
    /// @param merkleProofSiblings LeanIMT sibling path of the member, computed off-chain from the
    ///        public member list; Semaphore reverts on a wrong path.
    function finalizeRemoval(bytes32 uid, uint256[] calldata merkleProofSiblings) external {
        if (!removalPending[uid]) {
            revert RemovalNotPending(uid);
        }

        removalPending[uid] = false;

        uint8 riskTier = tierOf[uid];
        uint256 identityCommitment = commitmentOf[uid];

        SEMAPHORE.removeMember(_groupIds[riskTier], identityCommitment, merkleProofSiblings);

        emit RemovalFinalized(uid, riskTier, identityCommitment);
    }

    /// @inheritdoc IComplianceSetManager
    function groupIdOf(uint8 riskTier) external view returns (uint256) {
        if (!_tierExists[riskTier]) {
            revert TierUnknown(riskTier);
        }
        return _groupIds[riskTier];
    }

    /// @inheritdoc IComplianceSetManager
    function tierExists(uint8 riskTier) external view returns (bool) {
        return _tierExists[riskTier];
    }
}
