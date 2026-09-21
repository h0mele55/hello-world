// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ISemaphoreVerifier} from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";

/// @notice Always-true Groth16 verifier, used only to exercise the router's success path in unit
///         tests (real proofs are generated and verified in the TypeScript demo, sdk/examples/demo.ts).
///         Semaphore's own root/depth/membership checks still apply in front of this mock.
contract MockSemaphoreVerifier is ISemaphoreVerifier {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[4] calldata, uint256)
        external
        pure
        returns (bool)
    {
        return true;
    }
}
