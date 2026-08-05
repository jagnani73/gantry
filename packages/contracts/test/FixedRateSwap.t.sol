// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FixedRateSwap} from "../src/FixedRateSwap.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockXSGD} from "../src/mocks/MockXSGD.sol";

contract FixedRateSwapTest is Test {
    FixedRateSwap internal swap;
    MockUSDC internal usdc;
    MockXSGD internal xsgd;

    address internal trader;
    uint256 internal constant RATE = 1_342_100;

    function setUp() public {
        usdc = new MockUSDC();
        xsgd = new MockXSGD();
        swap = new FixedRateSwap(IERC20(address(xsgd)));
        swap.setRate(address(usdc), RATE);
        xsgd.mint(address(swap), 1_000_000e6);

        trader = makeAddr("trader");
        usdc.mint(trader, 1_000_000e6);
        vm.prank(trader);
        usdc.approve(address(swap), type(uint256).max);
    }

    function test_revert_constructorZeroXsgd() public {
        vm.expectRevert(FixedRateSwap.ZeroAddress.selector);
        new FixedRateSwap(IERC20(address(0)));
    }

    function test_swapExactIn_happy() public {
        uint256 amountIn = 4_843_157;
        uint256 expectedOut = (amountIn * RATE) / 1e6; // 6_500_001

        vm.expectEmit(true, false, false, true, address(swap));
        emit FixedRateSwap.Swapped(address(usdc), amountIn, expectedOut, trader);

        vm.prank(trader);
        uint256 out = swap.swapExactIn(address(usdc), amountIn, expectedOut, trader);

        assertEq(out, expectedOut);
        assertEq(xsgd.balanceOf(trader), expectedOut);
        assertEq(usdc.balanceOf(address(swap)), amountIn);
    }

    function test_revert_unsupportedToken() public {
        // The drain scenario from review: a worthless token must not buy XSGD.
        MockUSDC junk = new MockUSDC();
        junk.mint(trader, 1_000_000e6);
        vm.startPrank(trader);
        junk.approve(address(swap), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(FixedRateSwap.TokenUnsupported.selector, address(junk)));
        swap.swapExactIn(address(junk), 1_000_000e6, 0, trader);
        vm.stopPrank();
    }

    function test_revert_selfReferentialXsgdSwap() public {
        // The money-printer scenario from review: XSGD has no rate, so XSGD-in is refused.
        xsgd.mint(trader, 10e6);
        vm.startPrank(trader);
        xsgd.approve(address(swap), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(FixedRateSwap.TokenUnsupported.selector, address(xsgd)));
        swap.swapExactIn(address(xsgd), 1e6, 0, trader);
        vm.stopPrank();
    }

    function test_revert_dustRoundsToZeroOutput() public {
        vm.prank(trader);
        vm.expectRevert(FixedRateSwap.ZeroOutput.selector);
        swap.swapExactIn(address(usdc), 0, 0, trader);
    }

    function test_revert_belowMinOut() public {
        uint256 amountIn = 4_843_157;
        uint256 out = (amountIn * RATE) / 1e6;
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(FixedRateSwap.InsufficientOutput.selector, out, out + 1));
        swap.swapExactIn(address(usdc), amountIn, out + 1, trader);
    }

    function test_setRate_delistsAtZero() public {
        swap.setRate(address(usdc), 0);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(FixedRateSwap.TokenUnsupported.selector, address(usdc)));
        swap.swapExactIn(address(usdc), 1e6, 0, trader);
    }

    function test_rescueERC20_recoversBothSides() public {
        vm.prank(trader);
        swap.swapExactIn(address(usdc), 10e6, 0, trader);

        address treasury = makeAddr("treasury");
        swap.rescueERC20(address(usdc), treasury, 10e6);
        assertEq(usdc.balanceOf(treasury), 10e6, "accumulated pay tokens are recoverable");

        swap.rescueERC20(address(xsgd), treasury, 1e6);
        assertEq(xsgd.balanceOf(treasury), 1e6, "excess liquidity is recoverable");
    }

    function test_revert_adminFunctions_notOwner() public {
        address rando = makeAddr("rando");
        vm.startPrank(rando);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando));
        swap.setRate(address(usdc), 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando));
        swap.rescueERC20(address(xsgd), rando, 1);
        vm.stopPrank();
    }

    function test_revert_rescueToZeroAddress() public {
        vm.expectRevert(FixedRateSwap.ZeroAddress.selector);
        swap.rescueERC20(address(xsgd), address(0), 1);
    }

    function test_renounceOwnership_disabled() public {
        vm.expectRevert(FixedRateSwap.OwnershipCannotBeRenounced.selector);
        swap.renounceOwnership();
    }

    function test_ownershipTransfer_isTwoStep() public {
        address newOwner = makeAddr("newOwner");
        swap.transferOwnership(newOwner);
        assertEq(swap.owner(), address(this));
        vm.prank(newOwner);
        swap.acceptOwnership();
        assertEq(swap.owner(), newOwner);
    }

    /// @dev The quoting contract the backend must mirror: for any price and rate, a
    ///      ceil-rounded quote settles and never delivers less XSGD than the price.
    ///      The demo constants only ever exercise one (amount, rate) point; this pins
    ///      the property everywhere the relayer can quote.
    function testFuzz_ceilQuoteAlwaysCoversPrice(uint128 xsgdAmount, uint256 rate) public {
        xsgdAmount = uint128(bound(xsgdAmount, 1, 1_000_000_000_000)); // up to S$1M
        rate = bound(rate, 500_000, 3_000_000); // 0.5–3.0 SGD per unit
        swap.setRate(address(usdc), rate);

        uint256 amountIn = (uint256(xsgdAmount) * 1e6 + rate - 1) / rate; // ceil quote
        uint256 expectedOut = (amountIn * rate) / 1e6;
        xsgd.mint(address(swap), expectedOut); // top up liquidity for extreme draws
        usdc.mint(trader, amountIn);

        vm.prank(trader);
        uint256 out = swap.swapExactIn(address(usdc), amountIn, xsgdAmount, trader);

        assertGe(out, xsgdAmount, "ceil-rounded quote must always cover the price");
        assertEq(xsgd.balanceOf(trader), out);
    }
}
