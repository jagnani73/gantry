// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IGantrySwap} from "../../src/interfaces/IGantrySwap.sol";
import {GantryCore} from "../../src/GantryCore.sol";

/// @notice Delivers one unit less than minOut while claiming success — exists to prove
///         GantryCore trusts its own XSGD balance delta, not the swap's return value.
contract LyingSwap is IGantrySwap {
    IERC20 internal immutable xsgd;

    constructor(IERC20 xsgd_) {
        xsgd = xsgd_;
    }

    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256)
    {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        xsgd.transfer(to, minOut - 1);
        return minOut; // the lie
    }
}

/// @notice Attempts to re-enter settleWithAuthorization mid-swap and records the error
///         selector it was rejected with, then completes the swap honestly.
contract ReentrantSwap is IGantrySwap {
    GantryCore internal immutable core;
    IERC20 internal immutable xsgd;

    bytes4 public reentryError;
    bytes32 public reentryIntentId;

    constructor(GantryCore core_, IERC20 xsgd_) {
        core = core_;
        xsgd = xsgd_;
    }

    function setReentryIntentId(bytes32 intentId) external {
        reentryIntentId = intentId;
    }

    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256)
    {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        try core.settleWithAuthorization(reentryIntentId, address(0), 0, 0, 0, bytes32(0), bytes32(0)) {
            // A successful re-entry would mean the guard is broken; leave selector empty.
        } catch (bytes memory err) {
            bytes4 selector;
            assembly {
                selector := mload(add(err, 0x20))
            }
            reentryError = selector;
        }
        xsgd.transfer(to, minOut);
        return minOut;
    }
}
