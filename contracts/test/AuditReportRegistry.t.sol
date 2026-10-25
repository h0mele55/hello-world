// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {AuditReportRegistry} from "../src/AuditReportRegistry.sol";

contract AuditReportRegistryTest is Test {
    AuditReportRegistry internal registry;

    address internal owner = makeAddr("owner");
    address internal issuer = makeAddr("issuer");
    address internal issuer2 = makeAddr("issuer2"); // same org as `issuer`
    address internal otherOrgIssuer = makeAddr("otherOrgIssuer");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant ORG = keccak256("org:ledger-audit");
    bytes32 internal constant OTHER_ORG = keccak256("org:someone-else");
    bytes32 internal constant FAMILY = keccak256("family:1");
    uint32 internal constant DELAY = 1 days;

    function setUp() public {
        registry = new AuditReportRegistry(owner, DELAY);
        vm.startPrank(owner);
        registry.setIssuer(issuer, ORG, true);
        registry.setIssuer(issuer2, ORG, true);
        registry.setIssuer(otherOrgIssuer, OTHER_ORG, true);
        vm.stopPrank();
    }

    // ── helpers ──

    function _doc(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encode("doc", n));
    }

    function _anchor(address who, bytes32 family, uint32 version, bytes32 parent, bytes32 doc)
        internal
        returns (bytes32)
    {
        vm.prank(who);
        return registry.anchor(
            family,
            version,
            parent,
            doc,
            keccak256(abi.encode("m", doc)),
            keccak256(abi.encode("o", doc))
        );
    }

    function _v1() internal returns (bytes32) {
        return _anchor(issuer, FAMILY, 1, bytes32(0), _doc(1));
    }

    // ── construction and ownership ──

    function test_constructor_refusesZeroOwner() public {
        vm.expectRevert(AuditReportRegistry.ZeroValue.selector);
        new AuditReportRegistry(address(0), DELAY);
    }

    function test_constructor_setsTheDelay_andCapsIt() public {
        assertEq(registry.revocationDelay(), DELAY);
        uint32 max = registry.MAX_REVOCATION_DELAY();
        assertEq(max, 30 days);
        assertEq(new AuditReportRegistry(owner, max).revocationDelay(), max);
        assertEq(new AuditReportRegistry(owner, 0).revocationDelay(), 0);
        vm.expectRevert(
            abi.encodeWithSelector(AuditReportRegistry.DelayTooLong.selector, max + 1, max)
        );
        new AuditReportRegistry(owner, max + 1);
    }

    function test_ownership_isTwoStep() public {
        address next = makeAddr("safe");
        vm.prank(owner);
        registry.transferOwnership(next);
        assertEq(registry.owner(), owner, "owner changes only on accept");
        assertEq(registry.pendingOwner(), next);

        vm.prank(stranger);
        vm.expectRevert(AuditReportRegistry.NotPendingOwner.selector);
        registry.acceptOwnership();

        vm.prank(next);
        registry.acceptOwnership();
        assertEq(registry.owner(), next);
        assertEq(registry.pendingOwner(), address(0));
    }

    function test_transferOwnership_onlyOwner_andNotZero() public {
        vm.prank(stranger);
        vm.expectRevert(AuditReportRegistry.NotOwner.selector);
        registry.transferOwnership(stranger);

        vm.prank(owner);
        vm.expectRevert(AuditReportRegistry.ZeroValue.selector);
        registry.transferOwnership(address(0));
    }

    // ── issuers ──

    function test_setIssuer_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(AuditReportRegistry.NotOwner.selector);
        registry.setIssuer(stranger, ORG, true);
    }

    function test_setIssuer_refusesZeroValues() public {
        vm.startPrank(owner);
        vm.expectRevert(AuditReportRegistry.ZeroValue.selector);
        registry.setIssuer(address(0), ORG, true);
        vm.expectRevert(AuditReportRegistry.ZeroValue.selector);
        registry.setIssuer(stranger, bytes32(0), true);
        vm.stopPrank();
    }

    function test_setIssuer_keyCannotChangeOrg() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(AuditReportRegistry.IssuerOrgImmutable.selector, ORG)
        );
        registry.setIssuer(issuer, OTHER_ORG, true);
    }

    function test_setIssuer_deactivatedKeyCannotWrite() public {
        vm.prank(owner);
        registry.setIssuer(issuer, ORG, false);
        vm.prank(issuer);
        vm.expectRevert(AuditReportRegistry.NotIssuer.selector);
        registry.anchor(FAMILY, 1, bytes32(0), _doc(1), _doc(2), _doc(3));
    }

    // ── anchor ──

    function test_anchor_v1_recordsEverything() public {
        vm.roll(42);
        bytes32 id = _v1();
        assertEq(id, registry.recordIdFor(FAMILY, 1, AuditReportRegistry.Kind.ORIGINAL));
        AuditReportRegistry.RecordView memory r = registry.getRecord(id);
        assertEq(r.familyId, FAMILY);
        assertEq(r.docHash, _doc(1));
        assertEq(r.version, 1);
        assertEq(r.parentId, bytes32(0));
        assertEq(r.issuer, issuer);
        assertEq(r.blockNumber, 42);
        assertEq(uint8(r.kind), uint8(AuditReportRegistry.Kind.ORIGINAL));
        assertFalse(r.revoked);
        assertEq(r.revokeReason, 0);
        assertEq(r.revokeEffectiveAt, 0);
        assertEq(registry.recordOfDoc(_doc(1)), id);
        assertEq(registry.latestOf(FAMILY), id);
        assertEq(registry.familyOrg(FAMILY), ORG);
    }

    function test_anchor_emitsAnchored() public {
        bytes32 expected = registry.recordIdFor(FAMILY, 1, AuditReportRegistry.Kind.ORIGINAL);
        vm.expectEmit(address(registry));
        emit AuditReportRegistry.Anchored(
            expected, FAMILY, _doc(1), 1, AuditReportRegistry.Kind.ORIGINAL, bytes32(0), issuer
        );
        _v1();
    }

    function test_anchor_v2_supersedesV1() public {
        bytes32 v1 = _v1();
        bytes32 v2 = _anchor(issuer2, FAMILY, 2, v1, _doc(2));
        assertEq(registry.latestOf(FAMILY), v2);
        assertEq(registry.getRecord(v2).parentId, v1);
    }

    function test_anchor_refusesNonIssuer() public {
        vm.prank(stranger);
        vm.expectRevert(AuditReportRegistry.NotIssuer.selector);
        registry.anchor(FAMILY, 1, bytes32(0), _doc(1), _doc(2), _doc(3));
    }

    function test_anchor_refusesZeroValues() public {
        bytes32 z;
        vm.startPrank(issuer);
        vm.expectRevert(AuditReportRegistry.ZeroValue.selector);
        registry.anchor(z, 1, z, _doc(1), _doc(2), _doc(3));
        vm.expectRevert(AuditReportRegistry.ZeroValue.selector);
        registry.anchor(FAMILY, 1, z, z, _doc(2), _doc(3));
        vm.expectRevert(AuditReportRegistry.ZeroValue.selector);
        registry.anchor(FAMILY, 1, z, _doc(1), z, _doc(3));
        vm.expectRevert(AuditReportRegistry.ZeroValue.selector);
        registry.anchor(FAMILY, 1, z, _doc(1), _doc(2), z);
        vm.stopPrank();
    }

    function test_anchor_refusesReusedDoc() public {
        bytes32 v1 = _v1();
        vm.prank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(AuditReportRegistry.DocAlreadyAnchored.selector, _doc(1), v1)
        );
        registry.anchor(keccak256("family:2"), 1, bytes32(0), _doc(1), _doc(8), _doc(9));
    }

    function test_anchor_refusesSecondV1() public {
        _v1();
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(AuditReportRegistry.FamilyExists.selector, FAMILY));
        registry.anchor(FAMILY, 1, bytes32(0), _doc(7), _doc(8), _doc(9));
    }

    function test_anchor_v1_refusesParent() public {
        vm.prank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(AuditReportRegistry.StaleParent.selector, _doc(5), bytes32(0))
        );
        registry.anchor(FAMILY, 1, _doc(5), _doc(1), _doc(2), _doc(3));
    }

    function test_anchor_refusesVersionZero() public {
        bytes32 v1 = _v1();
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(AuditReportRegistry.BadVersion.selector, 0, 2));
        registry.anchor(FAMILY, 0, v1, _doc(2), _doc(8), _doc(9));
    }

    function test_familyOrg_survivesKeyDeactivation() public {
        bytes32 v1 = _v1();
        vm.prank(owner);
        registry.setIssuer(issuer, ORG, false);
        assertEq(registry.familyOrg(FAMILY), ORG, "deactivating the key keeps its org");
        // A colleague's key from the same org can still reissue.
        _anchor(issuer2, FAMILY, 2, v1, _doc(2));
    }

    function test_anchor_refusesUnknownFamily() public {
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(AuditReportRegistry.UnknownFamily.selector, FAMILY));
        registry.anchor(FAMILY, 2, _doc(5), _doc(1), _doc(2), _doc(3));
    }

    function test_anchor_refusesOtherOrgExtendingFamily() public {
        bytes32 v1 = _v1();
        vm.prank(otherOrgIssuer);
        vm.expectRevert(
            abi.encodeWithSelector(AuditReportRegistry.NotFamilyIssuer.selector, FAMILY)
        );
        registry.anchor(FAMILY, 2, v1, _doc(2), _doc(8), _doc(9));
    }

    function test_anchor_refusesStaleParent_theForkRace() public {
        bytes32 v1 = _v1();
        _anchor(issuer, FAMILY, 2, v1, _doc(2));
        // A second preparer read latest = v1 before v2 landed.
        bytes32 v2 = registry.latestOf(FAMILY);
        vm.prank(issuer2);
        vm.expectRevert(abi.encodeWithSelector(AuditReportRegistry.StaleParent.selector, v1, v2));
        registry.anchor(FAMILY, 2, v1, _doc(3), _doc(8), _doc(9));
    }

    function test_anchor_refusesSkippedVersion() public {
        bytes32 v1 = _v1();
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(AuditReportRegistry.BadVersion.selector, 3, 2));
        registry.anchor(FAMILY, 3, v1, _doc(2), _doc(8), _doc(9));
    }

    function test_anchor_newVersionAllowedAfterRevokedLatest() public {
        bytes32 v1 = _v1();
        vm.prank(issuer);
        registry.revoke(v1, 1);
        bytes32 v2 = _anchor(issuer, FAMILY, 2, v1, _doc(2));
        assertEq(registry.latestOf(FAMILY), v2);
    }

    // ── distribution copies ──

    function test_copy_recordsChildOfOriginal() public {
        bytes32 v1 = _v1();
        vm.prank(issuer);
        bytes32 copy = registry.anchorDistributionCopy(v1, _doc(100));
        AuditReportRegistry.RecordView memory c = registry.getRecord(copy);
        AuditReportRegistry.RecordView memory o = registry.getRecord(v1);
        assertEq(uint8(c.kind), uint8(AuditReportRegistry.Kind.DISTRIBUTION_COPY));
        assertEq(c.parentId, v1);
        assertEq(c.familyId, FAMILY);
        assertEq(c.version, 1);
        assertEq(c.opinionCommitment, o.opinionCommitment);
        assertEq(c.manifestHash, o.manifestHash);
        assertEq(registry.copyOf(v1), copy);
        assertEq(registry.recordOfDoc(_doc(100)), copy);
        assertEq(registry.latestOf(FAMILY), v1, "a copy never becomes the latest");
    }

    function test_copy_refusals() public {
        bytes32 v1 = _v1();
        vm.startPrank(issuer);
        vm.expectRevert(AuditReportRegistry.ZeroValue.selector);
        registry.anchorDistributionCopy(v1, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(AuditReportRegistry.UnknownRecord.selector, _doc(9)));
        registry.anchorDistributionCopy(_doc(9), _doc(100));
        vm.expectRevert(
            abi.encodeWithSelector(AuditReportRegistry.DocAlreadyAnchored.selector, _doc(1), v1)
        );
        registry.anchorDistributionCopy(v1, _doc(1));
        bytes32 copy = registry.anchorDistributionCopy(v1, _doc(100));
        vm.expectRevert(abi.encodeWithSelector(AuditReportRegistry.CopyExists.selector, v1, copy));
        registry.anchorDistributionCopy(v1, _doc(101));
        vm.expectRevert(abi.encodeWithSelector(AuditReportRegistry.NotOriginal.selector, copy));
        registry.anchorDistributionCopy(copy, _doc(102));
        vm.stopPrank();
    }

    function test_copy_refusesOtherOrg_andNonIssuer() public {
        bytes32 v1 = _v1();
        vm.prank(otherOrgIssuer);
        vm.expectRevert(
            abi.encodeWithSelector(AuditReportRegistry.NotFamilyIssuer.selector, FAMILY)
        );
        registry.anchorDistributionCopy(v1, _doc(100));
        vm.prank(stranger);
        vm.expectRevert(AuditReportRegistry.NotIssuer.selector);
        registry.anchorDistributionCopy(v1, _doc(100));
    }

    function test_copy_refusesAnOriginalBeingRevoked_andOneRevoked() public {
        bytes32 v1 = _v1();
        vm.prank(issuer);
        uint40 effectiveAt = registry.revoke(v1, 2);
        bytes memory refusal =
            abi.encodeWithSelector(AuditReportRegistry.RevocationExists.selector, v1, effectiveAt);
        vm.prank(issuer);
        vm.expectRevert(refusal);
        registry.anchorDistributionCopy(v1, _doc(100));
        vm.warp(effectiveAt);
        vm.prank(issuer);
        vm.expectRevert(refusal);
        registry.anchorDistributionCopy(v1, _doc(100));
    }

    function test_copy_allowedAfterTheOwnerCancels() public {
        bytes32 v1 = _v1();
        vm.prank(issuer);
        registry.revoke(v1, 2);
        vm.prank(owner);
        registry.cancelRevocation(v1);
        vm.prank(issuer);
        registry.anchorDistributionCopy(v1, _doc(100));
    }

    // ── revoke ──

    function test_revoke_waitsForTheDelay_thenTakesEffectWithoutAnotherTransaction() public {
        bytes32 v1 = _v1();
        uint40 expected = uint40(vm.getBlockTimestamp()) + DELAY;
        vm.expectEmit(address(registry));
        emit AuditReportRegistry.RevocationRequested(v1, 3, expected, issuer);
        vm.prank(issuer);
        assertEq(registry.revoke(v1, 3), expected);

        AuditReportRegistry.RecordView memory r = registry.getRecord(v1);
        assertFalse(r.revoked, "pending, not yet in effect");
        assertEq(r.revokeReason, 3);
        assertEq(r.revokeEffectiveAt, expected);

        vm.warp(expected - 1);
        assertFalse(registry.getRecord(v1).revoked, "one second early");
        vm.warp(expected);
        r = registry.getRecord(v1);
        assertTrue(r.revoked, "in effect at effectiveAt");
        assertEq(r.revokeReason, 3);
        assertEq(r.revokeEffectiveAt, expected);
    }

    function test_revoke_withNoDelayIsImmediate() public {
        AuditReportRegistry local = new AuditReportRegistry(owner, 0);
        vm.prank(owner);
        local.setIssuer(issuer, ORG, true);
        vm.prank(issuer);
        bytes32 v1 = local.anchor(FAMILY, 1, bytes32(0), _doc(1), _doc(2), _doc(3));
        vm.prank(issuer);
        assertEq(local.revoke(v1, 1), uint40(vm.getBlockTimestamp()));
        assertTrue(local.getRecord(v1).revoked);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                AuditReportRegistry.RevocationInEffect.selector, v1, uint40(vm.getBlockTimestamp())
            )
        );
        local.cancelRevocation(v1);
    }

    function test_revoke_oneAtATime_pendingOrInEffect() public {
        bytes32 v1 = _v1();
        vm.prank(issuer);
        uint40 effectiveAt = registry.revoke(v1, 3);
        bytes memory refusal =
            abi.encodeWithSelector(AuditReportRegistry.RevocationExists.selector, v1, effectiveAt);
        // A second key of the firm cannot replace a pending reason with its own.
        vm.prank(issuer2);
        vm.expectRevert(refusal);
        registry.revoke(v1, 1);
        vm.warp(effectiveAt);
        vm.prank(issuer2);
        vm.expectRevert(refusal);
        registry.revoke(v1, 1);
    }

    function test_cancelRevocation_byTheOwnerBeforeItTakesEffect() public {
        bytes32 v1 = _v1();
        vm.prank(issuer);
        uint40 effectiveAt = registry.revoke(v1, 3);
        vm.warp(effectiveAt - 1);
        vm.expectEmit(address(registry));
        emit AuditReportRegistry.RevocationCancelled(v1, 3, owner);
        vm.prank(owner);
        registry.cancelRevocation(v1);

        AuditReportRegistry.RecordView memory r = registry.getRecord(v1);
        assertFalse(r.revoked);
        assertEq(r.revokeReason, 0);
        assertEq(r.revokeEffectiveAt, 0);
        vm.warp(uint256(effectiveAt) + 365 days);
        assertFalse(registry.getRecord(v1).revoked, "a cancelled revocation never takes effect");

        // The firm may still withdraw the record later; the delay starts again.
        vm.prank(issuer2);
        uint40 again = registry.revoke(v1, 1);
        assertEq(again, uint40(vm.getBlockTimestamp()) + DELAY);
    }

    function test_cancelRevocation_refusals() public {
        bytes32 v1 = _v1();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AuditReportRegistry.NoRevocation.selector, v1));
        registry.cancelRevocation(v1);

        vm.prank(issuer);
        uint40 effectiveAt = registry.revoke(v1, 3);
        // An issuer key, even the one that asked, cannot cancel: only the owner can.
        address[3] memory notOwner = [issuer, issuer2, stranger];
        for (uint256 i; i < notOwner.length; i++) {
            vm.prank(notOwner[i]);
            vm.expectRevert(AuditReportRegistry.NotOwner.selector);
            registry.cancelRevocation(v1);
        }

        vm.warp(effectiveAt);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(AuditReportRegistry.RevocationInEffect.selector, v1, effectiveAt)
        );
        registry.cancelRevocation(v1);
        assertTrue(registry.getRecord(v1).revoked, "in effect is terminal");
    }

    function test_revoke_aDeactivatedKeysRevocationStillTakesEffectUnlessCancelled() public {
        bytes32 v1 = _v1();
        vm.prank(issuer);
        uint40 effectiveAt = registry.revoke(v1, 3);
        // Deactivating the key (a rotation, or a theft) does not undo what it asked;
        // only the owner's cancel does.
        vm.prank(owner);
        registry.setIssuer(issuer, ORG, false);
        vm.warp(effectiveAt);
        assertTrue(registry.getRecord(v1).revoked);
    }

    function test_revoke_refusals() public {
        bytes32 v1 = _v1();
        vm.prank(stranger);
        vm.expectRevert(AuditReportRegistry.NotIssuer.selector);
        registry.revoke(v1, 1);
        vm.prank(otherOrgIssuer);
        vm.expectRevert(
            abi.encodeWithSelector(AuditReportRegistry.NotFamilyIssuer.selector, FAMILY)
        );
        registry.revoke(v1, 1);
        vm.startPrank(issuer);
        vm.expectRevert(AuditReportRegistry.ZeroValue.selector);
        registry.revoke(v1, 0);
        vm.expectRevert(abi.encodeWithSelector(AuditReportRegistry.UnknownRecord.selector, _doc(9)));
        registry.revoke(_doc(9), 1);
        vm.stopPrank();
    }

    // ── reads and payability ──

    function test_unknownRecord_readsAsZero() public view {
        AuditReportRegistry.RecordView memory r = registry.getRecord(_doc(9));
        assertEq(r.docHash, bytes32(0));
        assertFalse(r.revoked);
        assertEq(r.revokeEffectiveAt, 0);
        assertEq(registry.recordOfDoc(_doc(9)), bytes32(0));
        assertEq(registry.latestOf(FAMILY), bytes32(0));
    }

    function test_recordId_bindsChainAndContract() public {
        bytes32 here = registry.recordIdFor(FAMILY, 1, AuditReportRegistry.Kind.ORIGINAL);
        AuditReportRegistry other = new AuditReportRegistry(owner, DELAY);
        assertTrue(here != other.recordIdFor(FAMILY, 1, AuditReportRegistry.Kind.ORIGINAL));
        vm.chainId(11155111);
        assertTrue(here != registry.recordIdFor(FAMILY, 1, AuditReportRegistry.Kind.ORIGINAL));
    }

    function test_refusesEther() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(registry).call{value: 1 wei}("");
        assertFalse(ok, "no receive or fallback: ether is refused");
    }

    // ── fuzz ──

    /// Any (version, parent) pair other than (latest.version + 1, latest) reverts.
    function testFuzz_anchor_onlyTheExactNextVersionOnTheLatestSucceeds(
        uint32 version,
        bytes32 parent,
        uint8 existing
    ) public {
        existing = uint8(bound(existing, 1, 6));
        bytes32 latest = _v1();
        for (uint32 v = 2; v <= existing; v++) {
            latest = _anchor(issuer, FAMILY, v, latest, _doc(v));
        }
        bool valid = version == existing + 1 && parent == latest;
        vm.prank(issuer);
        if (!valid) vm.expectRevert();
        registry.anchor(FAMILY, version, parent, _doc(1000), _doc(1001), _doc(1002));
        assertEq(registry.latestOf(FAMILY) != latest, valid);
    }

    function testFuzz_nonIssuerNeverWrites(address who, bytes32 family, bytes32 doc) public {
        vm.assume(who != issuer && who != issuer2 && who != otherOrgIssuer);
        vm.assume(family != bytes32(0) && doc != bytes32(0));
        vm.startPrank(who);
        vm.expectRevert(AuditReportRegistry.NotIssuer.selector);
        registry.anchor(family, 1, bytes32(0), doc, doc, doc);
        vm.expectRevert(AuditReportRegistry.NotIssuer.selector);
        registry.anchorDistributionCopy(family, doc);
        vm.expectRevert(AuditReportRegistry.NotIssuer.selector);
        registry.revoke(family, 1);
        vm.stopPrank();
    }

    /// Whatever the delay and whenever the record is read, it reads revoked
    /// exactly from effectiveAt on, and the owner can cancel exactly before it.
    function testFuzz_revocation_takesEffectExactlyAtItsTime(uint32 delay, uint32 later) public {
        delay = uint32(bound(delay, 0, 30 days));
        AuditReportRegistry r = new AuditReportRegistry(owner, delay);
        vm.prank(owner);
        r.setIssuer(issuer, ORG, true);
        vm.prank(issuer);
        bytes32 v1 = r.anchor(FAMILY, 1, bytes32(0), _doc(1), _doc(2), _doc(3));
        vm.prank(issuer);
        uint40 effectiveAt = r.revoke(v1, 1);
        assertEq(effectiveAt, uint40(vm.getBlockTimestamp()) + delay);
        vm.warp(vm.getBlockTimestamp() + later);
        bool due = vm.getBlockTimestamp() >= effectiveAt;
        assertEq(r.getRecord(v1).revoked, due);
        vm.prank(owner);
        if (due) vm.expectRevert();
        r.cancelRevocation(v1);
        assertEq(r.getRecord(v1).revokeReason, due ? 1 : 0);
    }
}
