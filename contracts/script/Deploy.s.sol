// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Script, console} from "forge-std/Script.sol";

import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/ISchemaRegistry.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/IEAS.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/resolver/ISchemaResolver.sol";
import {Semaphore} from "@semaphore-protocol/contracts/Semaphore.sol";
import {SemaphoreVerifier} from "@semaphore-protocol/contracts/base/SemaphoreVerifier.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {ISemaphoreVerifier} from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";

import {AccreditationRegistry} from "../src/AccreditationRegistry.sol";
import {ComplianceResolver} from "../src/ComplianceResolver.sol";
import {ComplianceRouter} from "../src/ComplianceRouter.sol";
import {ComplianceSetManager} from "../src/ComplianceSetManager.sol";
import {IComplianceSetManager} from "../src/interfaces/IComplianceSetManager.sol";

/// @notice Deploys the PoCA PoC to an OP Stack chain (target: OP Sepolia, chain id 11155420).
///         The EAS contracts are genesis predeploys on every OP Stack chain, so only the PoCA
///         contracts (and, if needed, Semaphore) are deployed here.
/// @dev Dry-run: `forge script script/Deploy.s.sol`
///      Broadcast: `forge script script/Deploy.s.sol --rpc-url $OP_SEPOLIA_RPC --private-key $PK --broadcast`
///      Reuse an existing Semaphore deployment by setting SEMAPHORE_ADDRESS.
contract Deploy is Script {
    address internal constant SCHEMA_REGISTRY_PREDEPLOY = 0x4200000000000000000000000000000000000020;
    address internal constant EAS_PREDEPLOY = 0x4200000000000000000000000000000000000021;
    uint256 internal constant OP_SEPOLIA_CHAIN_ID = 11155420;

    string internal constant AGENT_COMPLIANCE_SCHEMA =
        "uint256 agentId,address deployer,string frameworkVersion,uint8 dimensionsBitmap,uint8 riskTier,bytes32 agentVersionHash,bytes32 evidenceHash,uint256 identityCommitment";
    string internal constant VERIFIER_ACCREDITATION_SCHEMA =
        "string accreditationScheme,bytes32 accreditationRef,string verifierName";

    function run() external {
        vm.startBroadcast();

        address owner = msg.sender;

        // 1. Semaphore: reuse via SEMAPHORE_ADDRESS or deploy fresh (verifier + protocol).
        address semaphoreAddress = vm.envOr("SEMAPHORE_ADDRESS", address(0));
        if (semaphoreAddress == address(0)) {
            SemaphoreVerifier semaphoreVerifier = new SemaphoreVerifier();
            semaphoreAddress = address(new Semaphore(ISemaphoreVerifier(address(semaphoreVerifier))));
        }

        // 2. PoCA contracts.
        AccreditationRegistry accreditationRegistry = new AccreditationRegistry(owner);
        ComplianceSetManager setManager = new ComplianceSetManager(ISemaphore(semaphoreAddress), owner);
        ComplianceResolver resolver = new ComplianceResolver(
            IEAS(EAS_PREDEPLOY), accreditationRegistry, IComplianceSetManager(address(setManager))
        );
        ComplianceRouter router =
            new ComplianceRouter(ISemaphore(semaphoreAddress), IComplianceSetManager(address(setManager)));

        // 3. Wiring: resolver + one group per risk tier.
        setManager.setResolver(address(resolver));
        setManager.createTierGroup(1);
        setManager.createTierGroup(2);
        setManager.createTierGroup(3);

        // 4. Schema registration on the predeploy (only where the predeploys exist).
        if (block.chainid == OP_SEPOLIA_CHAIN_ID) {
            bytes32 complianceSchemaUid = ISchemaRegistry(SCHEMA_REGISTRY_PREDEPLOY).register(
                AGENT_COMPLIANCE_SCHEMA, ISchemaResolver(address(resolver)), true
            );
            bytes32 accreditationSchemaUid = ISchemaRegistry(SCHEMA_REGISTRY_PREDEPLOY).register(
                VERIFIER_ACCREDITATION_SCHEMA, ISchemaResolver(address(0)), true
            );
            console.log("AgentCompliance schema UID:", vm.toString(complianceSchemaUid));
            console.log("VerifierAccreditation schema UID:", vm.toString(accreditationSchemaUid));
        } else {
            console.log("Non-OP-Sepolia chain id (%s): skipping predeploy schema registration", block.chainid);
        }

        vm.stopBroadcast();

        console.log("Semaphore:            ", semaphoreAddress);
        console.log("AccreditationRegistry:", address(accreditationRegistry));
        console.log("ComplianceSetManager: ", address(setManager));
        console.log("ComplianceResolver:   ", address(resolver));
        console.log("ComplianceRouter:     ", address(router));
    }
}
