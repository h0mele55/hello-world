// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title AccreditationRegistry
/// @notice Authoritative record of which verifier addresses may issue AgentCompliance
///         attestations, with expiry (default policy: ~12 months, mirroring tester-accreditation
///         schemes such as AI TAP) and revocation.
/// @dev The EAS `VerifierAccreditation` attestation referenced by `accreditationUID` is a public
///      transparency mirror only — THIS contract is what the ComplianceResolver consults.
///      Indexers must treat this registry, not the mirror attestation, as the source of truth.
contract AccreditationRegistry is Ownable {
    struct Accreditation {
        uint64 expiresAt;
        bool revoked;
        bytes32 accreditationUID;
        string metadataURI;
    }

    mapping(address verifier => Accreditation) public accreditations;

    event VerifierAccredited(address indexed verifier, uint64 expiresAt, bytes32 accreditationUID, string metadataURI);
    event VerifierRevoked(address indexed verifier);

    error InvalidExpiry();
    error NotAccredited(address verifier);

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Grants (or re-grants) an accreditation. Re-granting clears a previous revocation,
    ///         so re-accreditation after remediation is an explicit owner act.
    function grantAccreditation(
        address verifier,
        uint64 expiresAt,
        bytes32 accreditationUID,
        string calldata metadataURI
    ) external onlyOwner {
        if (expiresAt <= block.timestamp) {
            revert InvalidExpiry();
        }

        accreditations[verifier] = Accreditation({
            expiresAt: expiresAt,
            revoked: false,
            accreditationUID: accreditationUID,
            metadataURI: metadataURI
        });

        emit VerifierAccredited(verifier, expiresAt, accreditationUID, metadataURI);
    }

    /// @notice Revokes a verifier's accreditation with immediate effect: every subsequent
    ///         AgentCompliance attestation from this address reverts at the resolver.
    function revokeAccreditation(address verifier) external onlyOwner {
        if (accreditations[verifier].expiresAt == 0) {
            revert NotAccredited(verifier);
        }

        accreditations[verifier].revoked = true;

        emit VerifierRevoked(verifier);
    }

    /// @notice True iff the verifier has been granted an accreditation that is neither revoked nor expired.
    function isAccredited(address verifier) public view returns (bool) {
        Accreditation storage accreditation = accreditations[verifier];
        return !accreditation.revoked && accreditation.expiresAt > block.timestamp;
    }
}
