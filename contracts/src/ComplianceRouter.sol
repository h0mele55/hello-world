// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {ISemaphoreGroups} from "@semaphore-protocol/contracts/interfaces/ISemaphoreGroups.sol";

import {IComplianceSetManager} from "./interfaces/IComplianceSetManager.sol";

/// @title ComplianceRouter
/// @notice The relying-party surface of the registry (the WorldIDRouter analog): verify a
///         Semaphore proof of membership in a risk-tier compliance set.
/// @dev DELIBERATELY VIEW-ONLY. Semaphore's own `validateProof` burns nullifiers globally per
///      group, which is wrong for a registry serving many independent relying parties — one
///      service's verification must not consume an agent's ability to prove to another. Each
///      relying party MUST therefore keep its own nullifier store per scope:
///
///      - `proof.scope` is the external nullifier: bind it to your service + action (+ epoch for
///        renewable allowances). One agent identity yields exactly one nullifier per scope.
///      - `proof.message` is the signal: bind it to a fresh challenge (nonce / request digest) to
///        prevent replay of a captured proof within the same scope.
///      - Reject a (scope, nullifier) pair you have seen before.
///
///      Root freshness: Semaphore accepts the group's current Merkle root, or a historical root
///      younger than the group's `merkleTreeDuration` (default 1 hour). Stricter relying parties
///      can require `proof.merkleTreeRoot == merkleTreeRoot(riskTier)`.
contract ComplianceRouter {
    ISemaphore public immutable SEMAPHORE;
    IComplianceSetManager public immutable SET_MANAGER;

    constructor(ISemaphore semaphore, IComplianceSetManager setManager) {
        SEMAPHORE = semaphore;
        SET_MANAGER = setManager;
    }

    /// @notice Verifies a membership proof for the given risk tier's compliance set.
    /// @return True iff the proof is valid for the tier's group (root current or within the
    ///         history window). Nullifier bookkeeping is the caller's responsibility, as
    ///         described in the contract-level documentation above.
    function verifyCompliance(uint8 riskTier, ISemaphore.SemaphoreProof calldata proof) external view returns (bool) {
        return SEMAPHORE.verifyProof(SET_MANAGER.groupIdOf(riskTier), proof);
    }

    /// @notice Semaphore group id backing a risk tier.
    function groupIdOf(uint8 riskTier) external view returns (uint256) {
        return SET_MANAGER.groupIdOf(riskTier);
    }

    /// @notice Current Merkle root of a tier's compliance set.
    function merkleTreeRoot(uint8 riskTier) external view returns (uint256) {
        return ISemaphoreGroups(address(SEMAPHORE)).getMerkleTreeRoot(SET_MANAGER.groupIdOf(riskTier));
    }

    /// @notice Current member count of a tier's compliance set.
    function merkleTreeSize(uint8 riskTier) external view returns (uint256) {
        return ISemaphoreGroups(address(SEMAPHORE)).getMerkleTreeSize(SET_MANAGER.groupIdOf(riskTier));
    }
}
