// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {LeafAlreadyExists} from "@zk-kit/lean-imt.sol/InternalLeanIMT.sol";

import {ComplianceResolver} from "../src/ComplianceResolver.sol";
import {ComplianceSetManager} from "../src/ComplianceSetManager.sol";
import {PocaTestBase} from "./helpers/PocaTestBase.sol";

contract ComplianceResolverTest is PocaTestBase {
    uint256 internal constant COMMITMENT = 0x1234567890abcdef;

    function test_accreditedAttestInsertsMember() public {
        bytes32 uid = _attest(2, COMMITMENT);

        assertEq(setManager.commitmentOf(uid), COMMITMENT);
        assertEq(setManager.tierOf(uid), 2);

        uint256 groupId = setManager.groupIdOf(2);
        assertTrue(semaphoreGroups.hasMember(groupId, COMMITMENT));
        assertEq(semaphoreGroups.getMerkleTreeSize(groupId), 1);
        // A LeanIMT with a single leaf has that leaf as its root.
        assertEq(semaphoreGroups.getMerkleTreeRoot(groupId), COMMITMENT);
    }

    function test_unaccreditedAttesterReverts() public {
        vm.expectRevert(abi.encodeWithSelector(ComplianceResolver.AttesterNotAccredited.selector, stranger));
        _attestAs(stranger, 1, COMMITMENT, uint64(block.timestamp + 180 days));
    }

    function test_revokedVerifierCannotAttest() public {
        vm.prank(foundation);
        accreditationRegistry.revokeAccreditation(verifier);

        vm.expectRevert(abi.encodeWithSelector(ComplianceResolver.AttesterNotAccredited.selector, verifier));
        _attest(1, COMMITMENT);
    }

    function test_expiredVerifierCannotAttest() public {
        vm.warp(block.timestamp + 365 days + 1);

        vm.expectRevert(abi.encodeWithSelector(ComplianceResolver.AttesterNotAccredited.selector, verifier));
        _attest(1, COMMITMENT);
    }

    function test_attestationWithoutExpiryReverts() public {
        vm.expectRevert(ComplianceResolver.ExpirationRequired.selector);
        _attestAs(verifier, 1, COMMITMENT, 0);
    }

    function test_zeroCommitmentReverts() public {
        vm.expectRevert(ComplianceSetManager.InvalidCommitment.selector);
        _attest(1, 0);
    }

    function test_unknownTierReverts() public {
        vm.expectRevert(abi.encodeWithSelector(ComplianceSetManager.TierUnknown.selector, uint8(9)));
        _attest(9, COMMITMENT);
    }

    function test_duplicateCommitmentInSameTierReverts() public {
        _attest(1, COMMITMENT);

        // LeanIMT enforces unique leaves: re-attesting the same Semaphore identity into the same
        // tier requires removing the old membership first (or using a fresh identity).
        vm.expectRevert(LeafAlreadyExists.selector);
        _attest(1, COMMITMENT);
    }

    function test_sameCommitmentInDifferentTiersIsAllowed() public {
        bytes32 uidTier1 = _attest(1, COMMITMENT);
        bytes32 uidTier2 = _attest(2, COMMITMENT);

        assertTrue(semaphoreGroups.hasMember(setManager.groupIdOf(1), COMMITMENT));
        assertTrue(semaphoreGroups.hasMember(setManager.groupIdOf(2), COMMITMENT));
        assertEq(setManager.tierOf(uidTier1), 1);
        assertEq(setManager.tierOf(uidTier2), 2);
    }
}
