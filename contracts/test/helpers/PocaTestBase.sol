// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";

import {EAS} from "@ethereum-attestation-service/eas-contracts/EAS.sol";
import {
    AttestationRequest,
    AttestationRequestData,
    IEAS,
    RevocationRequest,
    RevocationRequestData
} from "@ethereum-attestation-service/eas-contracts/IEAS.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/ISchemaRegistry.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/SchemaRegistry.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/resolver/ISchemaResolver.sol";
import {Semaphore} from "@semaphore-protocol/contracts/Semaphore.sol";
import {SemaphoreVerifier} from "@semaphore-protocol/contracts/base/SemaphoreVerifier.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {ISemaphoreGroups} from "@semaphore-protocol/contracts/interfaces/ISemaphoreGroups.sol";
import {ISemaphoreVerifier} from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";

import {AccreditationRegistry} from "../../src/AccreditationRegistry.sol";
import {ComplianceResolver} from "../../src/ComplianceResolver.sol";
import {ComplianceRouter} from "../../src/ComplianceRouter.sol";
import {ComplianceSetManager} from "../../src/ComplianceSetManager.sol";
import {IComplianceSetManager} from "../../src/interfaces/IComplianceSetManager.sol";

/// @notice Deploys the REAL EAS and Semaphore contracts (from their published npm packages)
///         plus the wired PoCA stack, registers the AgentCompliance schema with the resolver
///         attached, and accredits one verifier.
contract PocaTestBase is Test {
    string internal constant AGENT_COMPLIANCE_SCHEMA =
        "uint256 agentId,address deployer,string frameworkVersion,uint8 dimensionsBitmap,uint8 riskTier,bytes32 agentVersionHash,bytes32 evidenceHash,uint256 identityCommitment";
    string internal constant FRAMEWORK_VERSION = "IMDA-MGF-AgenticAI-v1.5";

    SchemaRegistry internal schemaRegistry;
    EAS internal eas;
    Semaphore internal semaphore;
    ISemaphoreGroups internal semaphoreGroups;

    AccreditationRegistry internal accreditationRegistry;
    ComplianceSetManager internal setManager;
    ComplianceResolver internal resolver;
    ComplianceRouter internal router;

    bytes32 internal complianceSchemaUid;

    address internal foundation = makeAddr("foundation");
    address internal verifier = makeAddr("verifier");
    address internal agentDeployer = makeAddr("agentDeployer");
    address internal stranger = makeAddr("stranger");

    function setUp() public virtual {
        schemaRegistry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(schemaRegistry)));
        semaphore = new Semaphore(ISemaphoreVerifier(address(new SemaphoreVerifier())));
        semaphoreGroups = ISemaphoreGroups(address(semaphore));

        accreditationRegistry = new AccreditationRegistry(foundation);
        setManager = new ComplianceSetManager(ISemaphore(address(semaphore)), foundation);
        resolver = new ComplianceResolver(
            IEAS(address(eas)), accreditationRegistry, IComplianceSetManager(address(setManager))
        );
        router = new ComplianceRouter(ISemaphore(address(semaphore)), IComplianceSetManager(address(setManager)));

        vm.startPrank(foundation);
        setManager.setResolver(address(resolver));
        setManager.createTierGroup(1);
        setManager.createTierGroup(2);
        setManager.createTierGroup(3);
        accreditationRegistry.grantAccreditation(
            verifier, uint64(block.timestamp + 365 days), bytes32("accreditation-uid"), "ipfs://accreditation-metadata"
        );
        vm.stopPrank();

        complianceSchemaUid = schemaRegistry.register(AGENT_COMPLIANCE_SCHEMA, ISchemaResolver(address(resolver)), true);
    }

    function _complianceData(uint8 riskTier, uint256 identityCommitment) internal view returns (bytes memory) {
        return abi.encode(
            uint256(1),
            agentDeployer,
            FRAMEWORK_VERSION,
            uint8(0x0F),
            riskTier,
            keccak256("agent-version"),
            keccak256("evidence-manifest"),
            identityCommitment
        );
    }

    function _attest(uint8 riskTier, uint256 identityCommitment) internal returns (bytes32) {
        return _attestAs(verifier, riskTier, identityCommitment, uint64(block.timestamp + 180 days));
    }

    function _attestAs(address attester, uint8 riskTier, uint256 identityCommitment, uint64 expirationTime)
        internal
        returns (bytes32 uid)
    {
        vm.prank(attester);
        uid = eas.attest(
            AttestationRequest({
                schema: complianceSchemaUid,
                data: AttestationRequestData({
                    recipient: agentDeployer,
                    expirationTime: expirationTime,
                    revocable: true,
                    refUID: bytes32(0),
                    data: _complianceData(riskTier, identityCommitment),
                    value: 0
                })
            })
        );
    }

    function _revoke(bytes32 uid) internal {
        vm.prank(verifier);
        eas.revoke(RevocationRequest({schema: complianceSchemaUid, data: RevocationRequestData({uid: uid, value: 0})}));
    }
}
