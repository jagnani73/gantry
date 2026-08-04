// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IGantrySwap} from "./interfaces/IGantrySwap.sol";

/// @title FixedRateSwap — owner-set-rate converter into XSGD
/// @notice Honest interim module (and the documented demo fallback) behind IGantrySwap
///         until the GantrySwap AMM lands in M4. Holds pre-minted XSGD as liquidity.
contract FixedRateSwap is IGantrySwap, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable XSGD;

    /// @notice XSGD out (6dp) per 1e6 units of tokenIn — 1.3421 SGD/USDC = 1_342_100.
    uint256 public rate;

    error ZeroRate();
    error InsufficientOutput(uint256 got, uint256 min);

    event RateUpdated(uint256 rate);

    constructor(IERC20 xsgd_, uint256 rate_) Ownable(msg.sender) {
        if (rate_ == 0) revert ZeroRate();
        XSGD = xsgd_;
        rate = rate_;
        emit RateUpdated(rate_);
    }

    function setRate(uint256 rate_) external onlyOwner {
        if (rate_ == 0) revert ZeroRate();
        rate = rate_;
        emit RateUpdated(rate_);
    }

    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256 xsgdOut)
    {
        xsgdOut = (amountIn * rate) / 1e6;
        if (xsgdOut < minOut) revert InsufficientOutput(xsgdOut, minOut);
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        XSGD.safeTransfer(to, xsgdOut);
    }
}
