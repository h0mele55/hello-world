// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {AuditReportRegistry} from "../src/AuditReportRegistry.sol";

/// Gas per write. Each call is recorded in snapshots/ (CI runs these with
/// FORGE_SNAPSHOT_CHECK=true, so a change must be committed deliberately) and
/// held under a ceiling, so a regression is a red test rather than a number
/// nobody reads.
contract AuditReportRegistryGasTest is Test {
    AuditReportRegistry internal registry;
    address internal issuer = makeAddr("issuer");
    bytes32 internal constant FAMILY = keccak256("family");

    uint256 internal constant ANCHOR_CEILING = 200_000;
    // A copy repeats the family id and both commitments so that a verifier
    // holding the stamped file gets everything from one read (recordOfDoc, then
    // getRecord). Three extra storage slots, so a higher ceiling.
    uint256 internal constant COPY_CEILING = 250_000;
    // A revocation writes a fresh slot (its reason and the time it takes
    // effect) and reads the deployment's delay.
    uint256 internal constant REVOKE_CEILING = 80_000;
    uint256 internal constant CANCEL_CEILING = 40_000;
    // An audit-log head writes two fresh slots (#94); the firm's first also
    // writes its list's length, which this measures. Later ones cost less.
    uint256 internal constant AUDIT_HEAD_CEILING = 110_000;

    function setUp() public {
        registry = new AuditReportRegistry(address(this), 1 days);
        registry.setIssuer(issuer, keccak256("org"), true);
    }

    function test_gas_writes() public {
        vm.startPrank(issuer);
        bytes32 v1 = registry.anchor(
            FAMILY, 1, bytes32(0), keccak256("d1"), keccak256("m1"), keccak256("o1")
        );
        uint256 anchorV1 = vm.snapshotGasLastCall("anchor_v1");

        registry.anchor(FAMILY, 2, v1, keccak256("d2"), keccak256("m2"), keccak256("o2"));
        uint256 anchorV2 = vm.snapshotGasLastCall("anchor_v2");

        bytes32 copy = registry.anchorDistributionCopy(v1, keccak256("c1"));
        uint256 copyGas = vm.snapshotGasLastCall("anchor_distribution_copy");

        registry.revoke(copy, 1);
        uint256 revokeGas = vm.snapshotGasLastCall("revoke");
        vm.stopPrank();

        registry.cancelRevocation(copy);
        uint256 cancelGas = vm.snapshotGasLastCall("cancel_revocation");

        vm.prank(issuer);
        registry.recordAuditHead(keccak256("head"));
        uint256 auditHeadGas = vm.snapshotGasLastCall("record_audit_head");

        assertLt(anchorV1, ANCHOR_CEILING, "anchor v1");
        assertLt(anchorV2, ANCHOR_CEILING, "anchor v2");
        assertLt(copyGas, COPY_CEILING, "copy");
        assertLt(revokeGas, REVOKE_CEILING, "revoke");
        assertLt(cancelGas, CANCEL_CEILING, "cancel");
        assertLt(auditHeadGas, AUDIT_HEAD_CEILING, "audit head");
    }
}
