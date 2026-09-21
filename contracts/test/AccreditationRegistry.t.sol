// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {AccreditationRegistry} from "../src/AccreditationRegistry.sol";
import {PocaTestBase} from "./helpers/PocaTestBase.sol";

contract AccreditationRegistryTest is PocaTestBase {
    function test_grantedVerifierIsAccredited() public view {
        assertTrue(accreditationRegistry.isAccredited(verifier));
    }

    function test_unknownAddressIsNotAccredited() public view {
        assertFalse(accreditationRegistry.isAccredited(stranger));
    }

    function test_revocationTakesImmediateEffect() public {
        vm.prank(foundation);
        accreditationRegistry.revokeAccreditation(verifier);

        assertFalse(accreditationRegistry.isAccredited(verifier));
    }

    function test_accreditationExpires() public {
        vm.warp(block.timestamp + 365 days + 1);

        assertFalse(accreditationRegistry.isAccredited(verifier));
    }

    function test_regrantAfterRevocationReinstates() public {
        vm.startPrank(foundation);
        accreditationRegistry.revokeAccreditation(verifier);
        accreditationRegistry.grantAccreditation(
            verifier, uint64(block.timestamp + 365 days), bytes32("new-accreditation-uid"), "ipfs://renewed"
        );
        vm.stopPrank();

        assertTrue(accreditationRegistry.isAccredited(verifier));
    }

    function test_grantWithPastExpiryReverts() public {
        vm.prank(foundation);
        vm.expectRevert(AccreditationRegistry.InvalidExpiry.selector);
        accreditationRegistry.grantAccreditation(stranger, uint64(block.timestamp), bytes32(0), "");
    }

    function test_revokeUnknownVerifierReverts() public {
        vm.prank(foundation);
        vm.expectRevert(abi.encodeWithSelector(AccreditationRegistry.NotAccredited.selector, stranger));
        accreditationRegistry.revokeAccreditation(stranger);
    }

    function test_grantOnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        accreditationRegistry.grantAccreditation(stranger, uint64(block.timestamp + 1 days), bytes32(0), "");
    }

    function test_revokeOnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        accreditationRegistry.revokeAccreditation(verifier);
    }
}
