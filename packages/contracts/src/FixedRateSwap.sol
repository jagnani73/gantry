// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IGantrySwap} from "./interfaces/IGantrySwap.sol";

/// @title FixedRateSwap — owner-set-rate converter into XSGD
/// @notice Honest interim module behind IGantrySwap, designed to be swapped for an AMM
///         behind the same interface. Holds pre-minted XSGD as liquidity. Only tokens
///         with an owner-set rate are accepted, so the reserve cannot be drained with
///         arbitrary (or self-referential) tokens.
contract FixedRateSwap is IGantrySwap, Ownable2Step {
    using SafeERC20 for IERC20;

    IERC20 public immutable XSGD;

    /// @notice XSGD out (6dp) per 1e6 base units of tokenIn — 1.3421 SGD/USDC = 1_342_100.
    ///         Zero = token not supported. The per-1e6 scale assumes 6dp stables; do not
    ///         list a token with other decimals without rechecking the precision.
    mapping(address => uint256) public rateOf;

    error ZeroAddress();
    error TokenUnsupported(address tokenIn);
    error ZeroOutput();
    error InsufficientOutput(uint256 got, uint256 min);
    error OwnershipCannotBeRenounced();

    event RateUpdated(address indexed tokenIn, uint256 rate);
    event Swapped(address indexed tokenIn, uint256 amountIn, uint256 xsgdOut, address indexed to);
    event Rescued(address token, address to, uint256 amount);

    constructor(IERC20 xsgd_) Ownable(msg.sender) {
        if (address(xsgd_) == address(0)) revert ZeroAddress();
        XSGD = xsgd_;
    }

    /// @notice Set the fixed rate for a pay token; rate 0 delists it.
    function setRate(address tokenIn, uint256 rate) external onlyOwner {
        rateOf[tokenIn] = rate;
        emit RateUpdated(tokenIn, rate);
    }

    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256 xsgdOut)
    {
        uint256 rate = rateOf[tokenIn];
        if (rate == 0) revert TokenUnsupported(tokenIn);
        xsgdOut = (amountIn * rate) / 1e6;
        if (xsgdOut == 0) revert ZeroOutput();
        if (xsgdOut < minOut) revert InsufficientOutput(xsgdOut, minOut);
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        XSGD.safeTransfer(to, xsgdOut);
        emit Swapped(tokenIn, amountIn, xsgdOut, to);
    }

    /// @notice Withdraws accumulated pay tokens or excess XSGD liquidity — without this,
    ///         every settled token would strand here when an AMM replaces the module.
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    /// @dev The owner key is the only recovery route for stranded funds; renouncing it
    ///      would permanently brick that, so it is disabled.
    function renounceOwnership() public pure override {
        revert OwnershipCannotBeRenounced();
    }
}
