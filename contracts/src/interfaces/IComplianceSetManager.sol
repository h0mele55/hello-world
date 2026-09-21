// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/// @title IComplianceSetManager
/// @notice Interface between the EAS resolver (which reacts to attestations) and the
///         Semaphore membership sets (one group per risk tier).
interface IComplianceSetManager {
    /// @notice Registers a newly attested agent: inserts its Semaphore identity commitment
    ///         into the group of the attested risk tier. Callable only by the resolver.
    function onAttested(bytes32 uid, uint256 identityCommitment, uint8 riskTier) external;

    /// @notice Marks the membership backing a revoked attestation for removal.
    ///         Callable only by the resolver.
    function onRevoked(bytes32 uid) external;

    /// @notice Returns the Semaphore group id for a risk tier. Reverts for unknown tiers.
    function groupIdOf(uint8 riskTier) external view returns (uint256);

    /// @notice True if a group has been created for the given risk tier.
    function tierExists(uint8 riskTier) external view returns (bool);
}
