// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAgentPBMWallet} from "../../src/interfaces/IAgentPBMWallet.sol";
import {AgentPBMWallet} from "../../src/AgentPBMWallet.sol";
import {GantryCore} from "../../src/GantryCore.sol";

/// @notice Trivial stand-in for the real AgentPBMWallet: pays, stays silent, or reverts
///         with the wallet's own imported CategoryNotAllowed error — proving that policy
///         denials bubble out of GantryCore as decodable reverts.
contract MockPBMWallet is IAgentPBMWallet {
    enum Mode {
        Pay,
        Silent,
        RevertCategory
    }

    Mode public mode;

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function authorizeSpend(bytes32, uint16 categoryId, address token, uint256 amount, bytes calldata) external {
        // Imported from the real wallet so the selector mirror is compile-time.
        if (mode == Mode.RevertCategory) revert AgentPBMWallet.CategoryNotAllowed(categoryId);
        if (mode == Mode.Silent) return;
        SafeERC20.safeTransfer(IERC20(token), msg.sender, amount);
    }
}

/// @notice Re-enters settleFromPBM from inside authorizeSpend, records the rejection
///         selector, then pays honestly — proves the reentrancy lock covers the PBM door
///         even while an attacker-supplied wallet holds control.
contract ReentrantPBMWallet is IAgentPBMWallet {
    using SafeERC20 for IERC20;

    bytes4 public constant SHORT_REVERT_SENTINEL = 0xffffffff;

    GantryCore internal immutable core;

    bytes4 public reentryError;
    bytes32 public reentryIntentId;

    constructor(GantryCore core_) {
        core = core_;
    }

    function setReentryIntentId(bytes32 intentId) external {
        reentryIntentId = intentId;
    }

    function authorizeSpend(bytes32, uint16, address token, uint256 amount, bytes calldata) external {
        try core.settleFromPBM(reentryIntentId, address(this), "") {
        // A successful re-entry would mean the guard is broken; leave selector empty.
        }
        catch (bytes memory err) {
            if (err.length < 4) {
                reentryError = SHORT_REVERT_SENTINEL;
            } else {
                bytes4 selector;
                assembly ("memory-safe") {
                    selector := mload(add(err, 0x20))
                }
                reentryError = selector;
            }
        }
        IERC20(token).safeTransfer(msg.sender, amount);
    }
}
