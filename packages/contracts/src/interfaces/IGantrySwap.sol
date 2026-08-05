// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Swap hook behind GantryCore's settlement path — implementations are
///         swappable behind this interface (fixed-rate module or AMM) via core.setSwap.
interface IGantrySwap {
    /// @notice Pulls `amountIn` of `tokenIn` from msg.sender (requires prior approval)
    ///         and sends XSGD to `to`. MUST revert if the output is below `minOut`.
    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256 xsgdOut);
}
