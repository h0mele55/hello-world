// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Attestation} from "@ethereum-attestation-service/eas-contracts/Common.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/IEAS.sol";
import {SchemaResolver} from "@ethereum-attestation-service/eas-contracts/resolver/SchemaResolver.sol";

import {AccreditationRegistry} from "./AccreditationRegistry.sol";
import {IComplianceSetManager} from "./interfaces/IComplianceSetManager.sol";

/// @title ComplianceResolver
/// @notice EAS schema resolver attached to the `AgentCompliance` schema. EAS calls it inside every
///         attest/revoke on that schema, making it the enforcement point of the registry:
///         an attestation from an unaccredited verifier can never exist.
/// @dev Expected schema (fields abi-encoded in this order):
///      `uint256 agentId, address deployer, string frameworkVersion, uint8 dimensionsBitmap,
///       uint8 riskTier, bytes32 agentVersionHash, bytes32 evidenceHash, uint256 identityCommitment`
///      The PoC performs no on-chain ERC-8004 existence check on `agentId`; the binding is
///      validated off-chain by verifiers and surfaced by indexers.
contract ComplianceResolver is SchemaResolver {
    AccreditationRegistry public immutable ACCREDITATION_REGISTRY;
    IComplianceSetManager public immutable SET_MANAGER;

    error AttesterNotAccredited(address attester);
    error ExpirationRequired();

    constructor(IEAS eas, AccreditationRegistry accreditationRegistry, IComplianceSetManager setManager)
        SchemaResolver(eas)
    {
        ACCREDITATION_REGISTRY = accreditationRegistry;
        SET_MANAGER = setManager;
    }

    /// @dev Gates issuance and feeds the private track. Reverting here reverts the attestation.
    function onAttest(Attestation calldata attestation, uint256 /* value */ ) internal override returns (bool) {
        if (!ACCREDITATION_REGISTRY.isAccredited(attestation.attester)) {
            revert AttesterNotAccredited(attestation.attester);
        }
        // A compliance claim without an expiry is meaningless; see docs/02-imda-alignment.md §6.
        if (attestation.expirationTime == 0) {
            revert ExpirationRequired();
        }

        (,,,, uint8 riskTier,,, uint256 identityCommitment) =
            abi.decode(attestation.data, (uint256, address, string, uint8, uint8, bytes32, bytes32, uint256));

        SET_MANAGER.onAttested(attestation.uid, identityCommitment, riskTier);

        return true;
    }

    /// @dev Revocation must never be blockable; this only marks the membership for removal.
    function onRevoke(Attestation calldata attestation, uint256 /* value */ ) internal override returns (bool) {
        SET_MANAGER.onRevoked(attestation.uid);
        return true;
    }
}
