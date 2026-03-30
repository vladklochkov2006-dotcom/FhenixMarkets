// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ITaskManager, FunctionId, EncryptedInput} from "@fhenixprotocol/cofhe-contracts/ICofhe.sol";

// ============================================================================
// MockTaskManager — Pass-through mock for CoFHE TaskManager.
// Deployed at 0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9 via hardhat_setCode.
// "Encrypted" handles are sequential counters; plaintext values stored in mapping.
// ============================================================================

contract MockTaskManager is ITaskManager {

    uint256 private _nextHandle = 1;

    // handle => plaintext value
    mapping(uint256 => uint256) public plaintexts;

    // ACL: handle => (account => allowed)
    mapping(uint256 => mapping(address => bool)) public acl;

    function createTask(
        uint8   /*returnType*/,
        FunctionId funcId,
        uint256[] memory encryptedInputs,
        uint256[] memory extraInputs
    ) external override returns (uint256) {

        uint256 result;

        if (funcId == FunctionId.trivialEncrypt) {
            // extraInputs[0] = plaintext value
            result = extraInputs[0];
        } else if (funcId == FunctionId.add) {
            result = plaintexts[encryptedInputs[0]] + plaintexts[encryptedInputs[1]];
        } else if (funcId == FunctionId.sub) {
            uint256 a = plaintexts[encryptedInputs[0]];
            uint256 b = plaintexts[encryptedInputs[1]];
            require(a >= b, "MockTaskManager: underflow");
            result = a - b;
        } else if (funcId == FunctionId.mul) {
            result = plaintexts[encryptedInputs[0]] * plaintexts[encryptedInputs[1]];
        } else if (funcId == FunctionId.div) {
            uint256 b = plaintexts[encryptedInputs[1]];
            require(b > 0, "MockTaskManager: div by zero");
            result = plaintexts[encryptedInputs[0]] / b;
        } else if (funcId == FunctionId.rem) {
            result = plaintexts[encryptedInputs[0]] % plaintexts[encryptedInputs[1]];
        } else if (funcId == FunctionId.gt) {
            result = plaintexts[encryptedInputs[0]] > plaintexts[encryptedInputs[1]] ? 1 : 0;
        } else if (funcId == FunctionId.gte) {
            result = plaintexts[encryptedInputs[0]] >= plaintexts[encryptedInputs[1]] ? 1 : 0;
        } else if (funcId == FunctionId.lt) {
            result = plaintexts[encryptedInputs[0]] < plaintexts[encryptedInputs[1]] ? 1 : 0;
        } else if (funcId == FunctionId.lte) {
            result = plaintexts[encryptedInputs[0]] <= plaintexts[encryptedInputs[1]] ? 1 : 0;
        } else if (funcId == FunctionId.eq) {
            result = plaintexts[encryptedInputs[0]] == plaintexts[encryptedInputs[1]] ? 1 : 0;
        } else if (funcId == FunctionId.ne) {
            result = plaintexts[encryptedInputs[0]] != plaintexts[encryptedInputs[1]] ? 1 : 0;
        } else if (funcId == FunctionId.min) {
            uint256 a = plaintexts[encryptedInputs[0]];
            uint256 b = plaintexts[encryptedInputs[1]];
            result = a < b ? a : b;
        } else if (funcId == FunctionId.max) {
            uint256 a = plaintexts[encryptedInputs[0]];
            uint256 b = plaintexts[encryptedInputs[1]];
            result = a > b ? a : b;
        } else if (funcId == FunctionId.select) {
            // encryptedInputs: [control, ifTrue, ifFalse]
            uint256 ctrl = plaintexts[encryptedInputs[0]];
            result = ctrl != 0 ? plaintexts[encryptedInputs[1]] : plaintexts[encryptedInputs[2]];
        } else if (funcId == FunctionId.not) {
            result = ~plaintexts[encryptedInputs[0]];
        } else if (funcId == FunctionId.and) {
            result = plaintexts[encryptedInputs[0]] & plaintexts[encryptedInputs[1]];
        } else if (funcId == FunctionId.or) {
            result = plaintexts[encryptedInputs[0]] | plaintexts[encryptedInputs[1]];
        } else if (funcId == FunctionId.xor) {
            result = plaintexts[encryptedInputs[0]] ^ plaintexts[encryptedInputs[1]];
        } else if (funcId == FunctionId.shl) {
            result = plaintexts[encryptedInputs[0]] << plaintexts[encryptedInputs[1]];
        } else if (funcId == FunctionId.shr) {
            result = plaintexts[encryptedInputs[0]] >> plaintexts[encryptedInputs[1]];
        } else if (funcId == FunctionId.cast) {
            result = plaintexts[encryptedInputs[0]];
        } else if (funcId == FunctionId.square) {
            uint256 a = plaintexts[encryptedInputs[0]];
            result = a * a;
        } else {
            // Unknown op — return 0
            result = 0;
        }

        // Store result under a new handle
        uint256 handle = _nextHandle++;
        plaintexts[handle] = result;
        return handle;
    }

    function createRandomTask(
        uint8   /*returnType*/,
        uint256 seed,
        int32   /*securityZone*/
    ) external override returns (uint256) {
        uint256 handle = _nextHandle++;
        // Deterministic pseudo-random for testing
        plaintexts[handle] = uint256(keccak256(abi.encode(seed, handle)));
        return handle;
    }

    function createDecryptTask(uint256 /*ctHash*/, address /*requestor*/) external override {
        // No-op in mock — decrypt is synchronous
    }

    function verifyInput(
        EncryptedInput memory input,
        address /*sender*/
    ) external override returns (uint256) {
        uint256 handle = _nextHandle++;
        plaintexts[handle] = input.ctHash; // treat ctHash as plaintext in mock
        return handle;
    }

    function allow(uint256 ctHash, address account) external override {
        acl[ctHash][account] = true;
    }

    function isAllowed(uint256 ctHash, address account) external override returns (bool) {
        return acl[ctHash][account];
    }

    function isPubliclyAllowed(uint256 /*ctHash*/) external pure override returns (bool) {
        return true; // everything is "public" in mock
    }

    function allowGlobal(uint256 /*ctHash*/) external override {}

    function allowTransient(uint256 ctHash, address account) external override {
        acl[ctHash][account] = true;
    }

    function getDecryptResultSafe(uint256 ctHash) external view override returns (uint256, bool) {
        return (plaintexts[ctHash], true);
    }

    function getDecryptResult(uint256 ctHash) external view override returns (uint256) {
        return plaintexts[ctHash];
    }

    function publishDecryptResult(
        uint256 ctHash,
        uint256 result,
        bytes calldata /*signature*/
    ) external override {
        plaintexts[ctHash] = result;
    }

    function publishDecryptResultBatch(
        uint256[] calldata ctHashes,
        uint256[] calldata results,
        bytes[] calldata /*signatures*/
    ) external override {
        for (uint256 i = 0; i < ctHashes.length; i++) {
            plaintexts[ctHashes[i]] = results[i];
        }
    }

    function verifyDecryptResult(
        uint256 /*ctHash*/,
        uint256 /*result*/,
        bytes calldata /*signature*/
    ) external pure override returns (bool) {
        return true;
    }

    function verifyDecryptResultSafe(
        uint256 /*ctHash*/,
        uint256 /*result*/,
        bytes calldata /*signature*/
    ) external pure override returns (bool) {
        return true;
    }

    function verifyDecryptResultBatch(
        uint256[] calldata /*ctHashes*/,
        uint256[] calldata /*results*/,
        bytes[] calldata /*signatures*/
    ) external pure override returns (bool) {
        return true;
    }

    function verifyDecryptResultBatchSafe(
        uint256[] calldata ctHashes,
        uint256[] calldata /*results*/,
        bytes[] calldata /*signatures*/
    ) external pure override returns (bool[] memory) {
        bool[] memory res = new bool[](ctHashes.length);
        for (uint256 i = 0; i < ctHashes.length; i++) {
            res[i] = true;
        }
        return res;
    }
}
