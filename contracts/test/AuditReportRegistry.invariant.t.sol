// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {AuditReportRegistry} from "../src/AuditReportRegistry.sol";

/// Drives the registry with random anchors, copies, revocations, cancellations,
/// the passing of time and attempts by keys that are not issuers, and keeps a
/// ghost model of what must be true.
contract RegistryHandler is Test {
    AuditReportRegistry public immutable registry;
    address[] public issuerKeys;
    address public immutable stranger;
    address public immutable owner;

    bytes32[] public families;
    bytes32[] public recordIds;
    bytes32[] public originals;
    mapping(bytes32 familyId => uint32) public ghostVersion;
    mapping(bytes32 recordId => uint8) public ghostReason;
    mapping(bytes32 recordId => uint40) public ghostEffectiveAt;
    /// The time every call runs at; the invariants warp to it too.
    uint256 public currentTime;
    uint256 public strangerWrites;
    uint256 public staleAccepted;
    uint256 public replacedRevocations;
    uint256 public nonOwnerCancels;
    uint256 public lateCancels;
    /// The org's audit-log heads as written, and which the owner voided (#94).
    bytes32[] public ghostHeads;
    mapping(uint256 index => bool) public ghostVoided;
    uint256 public nonOwnerVoids;
    uint256 public revoids;
    /// Re-anchor roots as recorded, and which the owner voided (#65).
    bytes32[] public ghostRoots;
    mapping(uint256 index => bool) public ghostRootVoided;
    uint256 public nonOwnerRootWrites;
    uint256 public rootRevoids;
    uint256 private nonce;

    constructor(
        AuditReportRegistry registry_,
        address[] memory issuerKeys_,
        address stranger_,
        address owner_
    ) {
        registry = registry_;
        issuerKeys = issuerKeys_;
        stranger = stranger_;
        owner = owner_;
        currentTime = block.timestamp;
    }

    modifier atCurrentTime() {
        vm.warp(currentTime);
        _;
    }

    /// Moves time on by up to two days: the delay is one, so revocations are
    /// seen both pending and in effect.
    function passTime(uint32 seconds_) external {
        currentTime += bound(seconds_, 0, 2 days);
        vm.warp(currentTime);
    }

    function familyCount() external view returns (uint256) {
        return families.length;
    }

    function recordCount() external view returns (uint256) {
        return recordIds.length;
    }

    function _key(uint256 seed) private view returns (address) {
        return issuerKeys[seed % issuerKeys.length];
    }

    function _fresh() private returns (bytes32) {
        nonce++;
        return keccak256(abi.encode("fresh", nonce));
    }

    function startFamily(uint256 keySeed) external atCurrentTime {
        bytes32 family = _fresh();
        bytes32 doc = _fresh();
        vm.prank(_key(keySeed));
        bytes32 id = registry.anchor(family, 1, bytes32(0), doc, _fresh(), _fresh());
        families.push(family);
        recordIds.push(id);
        originals.push(id);
        ghostVersion[family] = 1;
    }

    /// Reissue, sometimes from a stale view of the family (which must revert).
    function reissue(uint256 familySeed, uint256 keySeed, bool stale) external atCurrentTime {
        if (families.length == 0) return;
        bytes32 family = families[familySeed % families.length];
        bytes32 latest = registry.latestOf(family);
        uint32 next = ghostVersion[family] + 1;
        bytes32 parent = stale ? registry.getRecord(latest).parentId : latest;
        vm.prank(_key(keySeed));
        try registry.anchor(family, next, parent, _fresh(), _fresh(), _fresh()) returns (
            bytes32 id
        ) {
            // Counted, not asserted: with fail_on_revert = false a failed
            // assertion inside a handler call would be swallowed.
            if (stale) staleAccepted++;
            recordIds.push(id);
            originals.push(id);
            ghostVersion[family] = next;
        } catch {}
    }

    function copy(uint256 originalSeed, uint256 keySeed) external atCurrentTime {
        if (originals.length == 0) return;
        bytes32 original = originals[originalSeed % originals.length];
        vm.prank(_key(keySeed));
        try registry.anchorDistributionCopy(original, _fresh()) returns (bytes32 id) {
            recordIds.push(id);
        } catch {}
    }

    function revoke(uint256 recordSeed, uint256 keySeed, uint8 reason) external atCurrentTime {
        if (recordIds.length == 0) return;
        bytes32 id = recordIds[recordSeed % recordIds.length];
        vm.prank(_key(keySeed));
        try registry.revoke(id, reason) returns (uint40 effectiveAt) {
            if (ghostReason[id] != 0) replacedRevocations++;
            ghostReason[id] = reason;
            ghostEffectiveAt[id] = effectiveAt;
        } catch {}
    }

    /// The owner, an issuer key or a stranger tries to cancel.
    function cancel(uint256 recordSeed, uint256 callerSeed) external atCurrentTime {
        if (recordIds.length == 0) return;
        bytes32 id = recordIds[recordSeed % recordIds.length];
        uint256 pick = callerSeed % 4;
        address caller = pick == 0 ? owner : pick == 1 ? stranger : _key(callerSeed / 4);
        vm.prank(caller);
        try registry.cancelRevocation(id) {
            if (caller != owner) nonOwnerCancels++;
            if (ghostReason[id] == 0 || currentTime >= ghostEffectiveAt[id]) lateCancels++;
            ghostReason[id] = 0;
            ghostEffectiveAt[id] = 0;
        } catch {}
    }

    /// An issuer key writes an audit-log head.
    function recordHead(uint256 keySeed) external atCurrentTime {
        bytes32 head = _fresh();
        vm.prank(_key(keySeed));
        try registry.recordAuditHead(head) returns (uint256 index) {
            assertEq(index, ghostHeads.length);
            ghostHeads.push(head);
        } catch {}
    }

    /// The owner, an issuer key or a stranger tries to void a head.
    function voidHead(uint256 indexSeed, uint256 callerSeed) external atCurrentTime {
        if (ghostHeads.length == 0) return;
        uint256 index = indexSeed % ghostHeads.length;
        uint256 pick = callerSeed % 4;
        address caller = pick == 0 ? owner : pick == 1 ? stranger : _key(callerSeed / 4);
        vm.prank(caller);
        try registry.voidAuditHead(keccak256("org"), index) {
            if (caller != owner) nonOwnerVoids++;
            if (ghostVoided[index]) revoids++;
            ghostVoided[index] = true;
        } catch {}
    }

    function headCount() external view returns (uint256) {
        return ghostHeads.length;
    }

    /// The owner, an issuer key or a stranger tries to record a re-anchor root.
    function recordRoot(uint256 callerSeed) external atCurrentTime {
        bytes32 root = _fresh();
        uint256 pick = callerSeed % 3;
        address caller = pick == 0 ? owner : pick == 1 ? stranger : _key(callerSeed / 3);
        vm.prank(caller);
        try registry.recordReanchorRoot(root, 11155111, address(0xBEEF), 1, 1) returns (
            uint256 index
        ) {
            if (caller != owner) nonOwnerRootWrites++;
            assertEq(index, ghostRoots.length);
            ghostRoots.push(root);
        } catch {}
    }

    /// The owner, an issuer key or a stranger tries to void a re-anchor root.
    function voidRoot(uint256 indexSeed, uint256 callerSeed) external atCurrentTime {
        if (ghostRoots.length == 0) return;
        uint256 index = indexSeed % ghostRoots.length;
        uint256 pick = callerSeed % 3;
        address caller = pick == 0 ? owner : pick == 1 ? stranger : _key(callerSeed / 3);
        vm.prank(caller);
        try registry.voidReanchorRoot(index) {
            if (caller != owner) nonOwnerRootWrites++;
            if (ghostRootVoided[index]) rootRevoids++;
            ghostRootVoided[index] = true;
        } catch {}
    }

    function rootCount() external view returns (uint256) {
        return ghostRoots.length;
    }

    function strangerAttempts(uint256 seed) external atCurrentTime {
        bytes32 target = recordIds.length == 0 ? _fresh() : recordIds[seed % recordIds.length];
        vm.startPrank(stranger);
        try registry.anchor(_fresh(), 1, bytes32(0), _fresh(), _fresh(), _fresh()) {
            strangerWrites++;
        } catch {}
        try registry.anchorDistributionCopy(target, _fresh()) {
            strangerWrites++;
        } catch {}
        try registry.revoke(target, 1) {
            strangerWrites++;
        } catch {}
        try registry.cancelRevocation(target) {
            strangerWrites++;
        } catch {}
        try registry.recordAuditHead(_fresh()) {
            strangerWrites++;
        } catch {}
        vm.stopPrank();
    }
}

contract AuditReportRegistryInvariantTest is Test {
    AuditReportRegistry internal registry;
    RegistryHandler internal handler;

    function setUp() public {
        address owner = makeAddr("owner");
        registry = new AuditReportRegistry(owner, 1 days);
        address[] memory keys = new address[](2);
        keys[0] = makeAddr("issuerA");
        keys[1] = makeAddr("issuerB");
        vm.startPrank(owner);
        registry.setIssuer(keys[0], keccak256("org"), true);
        registry.setIssuer(keys[1], keccak256("org"), true);
        vm.stopPrank();
        handler = new RegistryHandler(registry, keys, makeAddr("stranger"), owner);
        targetContract(address(handler));
    }

    /// A file hash maps to exactly the record that holds it.
    function invariant_docHashMapsToOneRecord() public view {
        for (uint256 i = 0; i < handler.recordCount(); i++) {
            bytes32 id = handler.recordIds(i);
            AuditReportRegistry.RecordView memory r = registry.getRecord(id);
            assertEq(registry.recordOfDoc(r.docHash), id);
        }
    }

    /// Each family has exactly one latest, an ORIGINAL, at the highest version,
    /// and its versions chain back to 1 with no gaps.
    function invariant_versionsContiguousWithOneLatest() public view {
        for (uint256 f = 0; f < handler.familyCount(); f++) {
            bytes32 family = handler.families(f);
            bytes32 cursor = registry.latestOf(family);
            uint32 expected = handler.ghostVersion(family);
            AuditReportRegistry.RecordView memory r = registry.getRecord(cursor);
            assertEq(uint8(r.kind), uint8(AuditReportRegistry.Kind.ORIGINAL));
            while (expected > 0) {
                r = registry.getRecord(cursor);
                assertEq(r.version, expected, "version gap");
                assertEq(r.familyId, family);
                cursor = r.parentId;
                expected--;
            }
            assertEq(cursor, bytes32(0), "chain does not end at version 1");
        }
    }

    /// Every record reads exactly the revocation it was asked for, and reads
    /// revoked exactly from that revocation's time on.
    function invariant_revocationReadsAsAsked() public {
        vm.warp(handler.currentTime());
        for (uint256 i = 0; i < handler.recordCount(); i++) {
            bytes32 id = handler.recordIds(i);
            AuditReportRegistry.RecordView memory r = registry.getRecord(id);
            uint8 reason = handler.ghostReason(id);
            uint40 effectiveAt = handler.ghostEffectiveAt(id);
            assertEq(r.revokeReason, reason);
            assertEq(r.revokeEffectiveAt, effectiveAt);
            assertEq(r.revoked, reason != 0 && block.timestamp >= effectiveAt);
        }
    }

    /// A revocation in effect never reverses: nobody cancels one at or after
    /// its time, and a second ask never replaces the first.
    function invariant_revokedIsTerminal() public view {
        assertEq(handler.lateCancels(), 0);
        assertEq(handler.replacedRevocations(), 0);
    }

    /// Only the owner cancels a revocation; an issuer key never does.
    function invariant_onlyTheOwnerCancels() public view {
        assertEq(handler.nonOwnerCancels(), 0);
    }

    /// A key that is not an issuer never writes.
    function invariant_nonIssuerNeverWrites() public view {
        assertEq(handler.strangerWrites(), 0);
    }

    /// A reissue naming anything but the current latest never lands.
    function invariant_staleParentNeverAccepted() public view {
        assertEq(handler.staleAccepted(), 0);
    }

    /// Audit-log heads are append-only: each reads as written, in order, and
    /// only its voided flag ever changes, once, by the owner (#94).
    function invariant_auditHeadsAppendOnly() public view {
        uint256 count = handler.headCount();
        assertEq(registry.auditHeadCount(keccak256("org")), count);
        AuditReportRegistry.AuditHead[] memory heads =
            registry.auditHeads(keccak256("org"), 0, count);
        for (uint256 i = 0; i < count; i++) {
            assertEq(heads[i].head, handler.ghostHeads(i));
            assertEq(heads[i].voided, handler.ghostVoided(i));
        }
        assertEq(handler.nonOwnerVoids(), 0);
        assertEq(handler.revoids(), 0);
    }

    /// Re-anchor roots are append-only and the owner's alone: each reads as
    /// recorded, in order, and only its voided flag ever changes, once (#65).
    function invariant_reanchorRootsAppendOnly() public view {
        uint256 count = handler.rootCount();
        assertEq(registry.reanchorRootCount(), count);
        AuditReportRegistry.ReanchorRoot[] memory roots = registry.reanchorRoots(0, count);
        for (uint256 i = 0; i < count; i++) {
            assertEq(roots[i].root, handler.ghostRoots(i));
            assertEq(roots[i].voided, handler.ghostRootVoided(i));
        }
        assertEq(handler.nonOwnerRootWrites(), 0);
        assertEq(handler.rootRevoids(), 0);
    }
}
