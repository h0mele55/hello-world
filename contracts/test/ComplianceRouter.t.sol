// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Semaphore} from "@semaphore-protocol/contracts/Semaphore.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {ISemaphoreVerifier} from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";

import {ComplianceRouter} from "../src/ComplianceRouter.sol";
import {ComplianceSetManager} from "../src/ComplianceSetManager.sol";
import {IComplianceSetManager} from "../src/interfaces/IComplianceSetManager.sol";
import {PocaTestBase} from "./helpers/PocaTestBase.sol";
import {MockSemaphoreVerifier} from "./mocks/MockSemaphoreVerifier.sol";

contract ComplianceRouterTest is PocaTestBase {
    uint256 internal constant COMMITMENT = 424242;

    // Parallel stack around an always-true Groth16 verifier: exercises the router's success path
    // without generating a real proof (real proofs are covered by the SDK demo).
    Semaphore internal mockSemaphore;
    ComplianceSetManager internal mockSetManager;
    ComplianceRouter internal mockRouter;

    function setUp() public override {
        super.setUp();

        mockSemaphore = new Semaphore(ISemaphoreVerifier(address(new MockSemaphoreVerifier())));
        mockSetManager = new ComplianceSetManager(ISemaphore(address(mockSemaphore)), address(this));
        mockSetManager.setResolver(address(this));
        mockSetManager.createTierGroup(1);
        // This test contract acts as the resolver for the mock stack.
        mockSetManager.onAttested(bytes32("uid-mock"), COMMITMENT, 1);
        mockRouter =
            new ComplianceRouter(ISemaphore(address(mockSemaphore)), IComplianceSetManager(address(mockSetManager)));
    }

    function _proof(uint256 merkleTreeRoot) internal pure returns (ISemaphore.SemaphoreProof memory) {
        return ISemaphore.SemaphoreProof({
            merkleTreeDepth: 1,
            merkleTreeRoot: merkleTreeRoot,
            nullifier: 42,
            message: 7,
            scope: 99,
            points: [uint256(0), 0, 0, 0, 0, 0, 0, 0]
        });
    }

    function test_verifyComplianceSucceedsForCurrentRoot() public view {
        // Proof carries the group's current root; the mock verifier accepts the ZK part.
        assertTrue(mockRouter.verifyCompliance(1, _proof(mockRouter.merkleTreeRoot(1))));
    }

    function test_verifyComplianceRejectsUnknownRoot() public {
        vm.expectRevert(ISemaphore.Semaphore__MerkleTreeRootIsNotPartOfTheGroup.selector);
        mockRouter.verifyCompliance(1, _proof(999999999));
    }

    function test_verifyComplianceRejectsInvalidZkProof() public {
        // Real Groth16 verifier + garbage proof points: the pairing check fails.
        _attest(1, COMMITMENT);
        assertFalse(router.verifyCompliance(1, _proof(router.merkleTreeRoot(1))));
    }

    function test_verifyComplianceEmptyGroupReverts() public {
        vm.expectRevert(ISemaphore.Semaphore__GroupHasNoMembers.selector);
        router.verifyCompliance(1, _proof(0));
    }

    function test_verifyComplianceUnknownTierReverts() public {
        vm.expectRevert(abi.encodeWithSelector(ComplianceSetManager.TierUnknown.selector, uint8(9)));
        mockRouter.verifyCompliance(9, _proof(0));
    }

    function test_helpersReflectGroupState() public {
        _attest(3, COMMITMENT);

        assertEq(router.groupIdOf(3), setManager.groupIdOf(3));
        assertEq(router.merkleTreeSize(3), 1);
        assertEq(router.merkleTreeRoot(3), COMMITMENT);
    }
}
