// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {AuditReportRegistry} from "../src/AuditReportRegistry.sol";

/// Drives the registry with random anchors, copies, revocations and attempts by
/// keys that are not issuers, and keeps a ghost model of what must be true.
contract RegistryHandler is Test {
    AuditReportRegistry public immutable registry;
    address[] public issuerKeys;
    address public immutable stranger;

    bytes32[] public families;
    bytes32[] public recordIds;
    bytes32[] public originals;
    mapping(bytes32 familyId => uint32) public ghostVersion;
    mapping(bytes32 recordId => bool) public ghostRevoked;
    uint256 public strangerWrites;
    uint256 public staleAccepted;
    uint256 private nonce;

    constructor(AuditReportRegistry registry_, address[] memory issuerKeys_, address stranger_) {
        registry = registry_;
        issuerKeys = issuerKeys_;
        stranger = stranger_;
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

    function startFamily(uint256 keySeed) external {
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
    function reissue(uint256 familySeed, uint256 keySeed, bool stale) external {
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

    function copy(uint256 originalSeed, uint256 keySeed) external {
        if (originals.length == 0) return;
        bytes32 original = originals[originalSeed % originals.length];
        vm.prank(_key(keySeed));
        try registry.anchorDistributionCopy(original, _fresh()) returns (bytes32 id) {
            recordIds.push(id);
        } catch {}
    }

    function revoke(uint256 recordSeed, uint256 keySeed, uint8 reason) external {
        if (recordIds.length == 0) return;
        bytes32 id = recordIds[recordSeed % recordIds.length];
        vm.prank(_key(keySeed));
        try registry.revoke(id, reason) {
            ghostRevoked[id] = true;
        } catch {}
    }

    function strangerAttempts(uint256 seed) external {
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
        vm.stopPrank();
    }
}

contract AuditReportRegistryInvariantTest is Test {
    AuditReportRegistry internal registry;
    RegistryHandler internal handler;

    function setUp() public {
        address owner = makeAddr("owner");
        registry = new AuditReportRegistry(owner);
        address[] memory keys = new address[](2);
        keys[0] = makeAddr("issuerA");
        keys[1] = makeAddr("issuerB");
        vm.startPrank(owner);
        registry.setIssuer(keys[0], keccak256("org"), true);
        registry.setIssuer(keys[1], keccak256("org"), true);
        vm.stopPrank();
        handler = new RegistryHandler(registry, keys, makeAddr("stranger"));
        targetContract(address(handler));
    }

    /// A file hash maps to exactly the record that holds it.
    function invariant_docHashMapsToOneRecord() public view {
        for (uint256 i = 0; i < handler.recordCount(); i++) {
            bytes32 id = handler.recordIds(i);
            AuditReportRegistry.Record memory r = registry.getRecord(id);
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
            AuditReportRegistry.Record memory r = registry.getRecord(cursor);
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

    /// Revocation never reverses.
    function invariant_revokedIsTerminal() public view {
        for (uint256 i = 0; i < handler.recordCount(); i++) {
            bytes32 id = handler.recordIds(i);
            if (handler.ghostRevoked(id)) assertTrue(registry.getRecord(id).revoked);
        }
    }

    /// A key that is not an issuer never writes.
    function invariant_nonIssuerNeverWrites() public view {
        assertEq(handler.strangerWrites(), 0);
    }

    /// A reissue naming anything but the current latest never lands.
    function invariant_staleParentNeverAccepted() public view {
        assertEq(handler.staleAccepted(), 0);
    }
}
