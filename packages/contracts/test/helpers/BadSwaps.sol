// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IGantrySwap} from "../../src/interfaces/IGantrySwap.sol";
import {GantryCore} from "../../src/GantryCore.sol";

/// @notice Delivers one unit less than minOut while claiming success — exists to prove
///         GantryCore trusts its own XSGD balance delta, not the swap's return value.
contract LyingSwap is IGantrySwap {
    using SafeERC20 for IERC20;

    IERC20 internal immutable xsgd;

    constructor(IERC20 xsgd_) {
        xsgd = xsgd_;
    }

    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256)
    {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        xsgd.safeTransfer(to, minOut - 1);
        return minOut; // the lie
    }
}

/// @notice Attempts to re-enter settleWithAuthorization mid-swap and records the error
///         selector it was rejected with, then completes the swap honestly.
contract ReentrantSwap is IGantrySwap {
    using SafeERC20 for IERC20;

    /// @dev Sentinel recorded when the re-entry reverted with <4 bytes of data — keeps
    ///      the test assert from reading garbage past a short revert payload.
    bytes4 public constant SHORT_REVERT_SENTINEL = 0xffffffff;

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
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        try core.settleWithAuthorization(reentryIntentId, address(0), 0, 0, 0, bytes32(0), bytes32(0)) {
            // A successful re-entry would mean the guard is broken; leave selector empty.
        } catch (bytes memory err) {
            reentryError = _selectorOf(err);
        }
        xsgd.safeTransfer(to, minOut);
        return minOut;
    }

    function _selectorOf(bytes memory err) internal pure returns (bytes4 selector) {
        if (err.length < 4) return SHORT_REVERT_SENTINEL;
        assembly ("memory-safe") {
            selector := mload(add(err, 0x20))
        }
    }
}
