// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ComplianceSetManager} from "../src/ComplianceSetManager.sol";
import {PocaTestBase} from "./helpers/PocaTestBase.sol";

contract ComplianceSetManagerTest is PocaTestBase {
    uint256 internal constant COMMITMENT_A = 111111;
    uint256 internal constant COMMITMENT_B = 222222;

    function test_revocationMarksRemovalPending() public {
        bytes32 uid = _attest(1, COMMITMENT_A);

        _revoke(uid);

        assertTrue(setManager.removalPending(uid));
        // The member is still in the group until the removal is finalized (two-phase removal).
        assertTrue(semaphoreGroups.hasMember(setManager.groupIdOf(1), COMMITMENT_A));
    }

    function test_finalizeRemovalSingleMember() public {
        bytes32 uid = _attest(1, COMMITMENT_A);
        _revoke(uid);

        // Single-leaf tree: the LeanIMT sibling path is empty.
        setManager.finalizeRemoval(uid, new uint256[](0));

        uint256 groupId = setManager.groupIdOf(1);
        assertFalse(semaphoreGroups.hasMember(groupId, COMMITMENT_A));
        assertFalse(setManager.removalPending(uid));
        // Removing the only leaf leaves a zeroed root.
        assertEq(semaphoreGroups.getMerkleTreeRoot(groupId), 0);
    }

    function test_finalizeRemovalWithSiblingPath() public {
        _attest(1, COMMITMENT_A);
        bytes32 uidB = _attest(1, COMMITMENT_B);
        _revoke(uidB);

        // Two-leaf tree [A, B]: the sibling path of leaf B is [A].
        uint256[] memory siblings = new uint256[](1);
        siblings[0] = COMMITMENT_A;
        setManager.finalizeRemoval(uidB, siblings);

        uint256 groupId = setManager.groupIdOf(1);
        assertFalse(semaphoreGroups.hasMember(groupId, COMMITMENT_B));
        assertTrue(semaphoreGroups.hasMember(groupId, COMMITMENT_A));
    }

    function test_finalizeRemovalWithoutRevocationReverts() public {
        bytes32 uid = _attest(1, COMMITMENT_A);

        vm.expectRevert(abi.encodeWithSelector(ComplianceSetManager.RemovalNotPending.selector, uid));
        setManager.finalizeRemoval(uid, new uint256[](0));
    }

    function test_finalizeRemovalTwiceReverts() public {
        bytes32 uid = _attest(1, COMMITMENT_A);
        _revoke(uid);
        setManager.finalizeRemoval(uid, new uint256[](0));

        vm.expectRevert(abi.encodeWithSelector(ComplianceSetManager.RemovalNotPending.selector, uid));
        setManager.finalizeRemoval(uid, new uint256[](0));
    }

    function test_onAttestedOnlyResolver() public {
        vm.prank(stranger);
        vm.expectRevert(ComplianceSetManager.OnlyResolver.selector);
        setManager.onAttested(bytes32("uid"), COMMITMENT_A, 1);
    }

    function test_onRevokedOnlyResolver() public {
        vm.prank(stranger);
        vm.expectRevert(ComplianceSetManager.OnlyResolver.selector);
        setManager.onRevoked(bytes32("uid"));
    }

    function test_createTierGroupTwiceReverts() public {
        vm.prank(foundation);
        vm.expectRevert(abi.encodeWithSelector(ComplianceSetManager.TierAlreadyExists.selector, uint8(1)));
        setManager.createTierGroup(1);
    }

    function test_createTierGroupOnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        setManager.createTierGroup(4);
    }

    function test_groupIdOfUnknownTierReverts() public {
        vm.expectRevert(abi.encodeWithSelector(ComplianceSetManager.TierUnknown.selector, uint8(7)));
        setManager.groupIdOf(7);
    }

    function test_tierExists() public view {
        assertTrue(setManager.tierExists(1));
        assertFalse(setManager.tierExists(7));
    }
}
