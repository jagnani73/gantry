// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GantryCore} from "../../src/GantryCore.sol";
import {FixedRateSwap} from "../../src/FixedRateSwap.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockXSGD} from "../../src/mocks/MockXSGD.sol";
import {Eip3009Digest} from "./Eip3009Digest.sol";

/// @notice Shared fixture seeded with the canonical demo facts: Ah Hock Chicken Rice,
///         S$6.50 = 6_500_000 XSGD, 1.3421 SGD/USDC, payer quoted 4.843157 USDC.
abstract contract GantryTestBase is Test {
    GantryCore internal core;
    MockUSDC internal usdc;
    MockXSGD internal xsgd;
    FixedRateSwap internal swap;

    uint256 internal constant PAYER_PK = 0xA11CE;
    address internal payer;
    address internal relayer;
    address internal payout;

    bytes32 internal merchantId;

    uint16 internal constant CATEGORY_FOOD_BEVERAGE = 1;
    uint128 internal constant XSGD_AMOUNT = 6_500_000; // S$6.50
    uint128 internal constant USDC_AMOUNT = 4_843_157; // ceil(6.50 / 1.3421), 6dp
    uint256 internal constant RATE = 1_342_100; // 1.3421 XSGD per USDC, 6dp

    function setUp() public virtual {
        vm.warp(1_755_000_000);
        payer = vm.addr(PAYER_PK);
        relayer = makeAddr("relayer");
        payout = makeAddr("payout");

        usdc = new MockUSDC();
        xsgd = new MockXSGD();
        swap = new FixedRateSwap(IERC20(address(xsgd)));
        swap.setRate(address(usdc), RATE);
        xsgd.mint(address(swap), 1_000_000e6);

        core = new GantryCore(IERC20(address(xsgd)), relayer);
        core.setSwap(swap);
        merchantId = core.registerMerchant("ah-hock-chicken-rice", payout, CATEGORY_FOOD_BEVERAGE);

        usdc.mint(payer, 1_000e6);
        xsgd.mint(payer, 1_000e6);
    }

    function _createIntent(address tokenIn, uint128 amountIn, GantryCore.Door door)
        internal
        returns (bytes32 intentId)
    {
        vm.prank(relayer);
        intentId =
            core.createIntent(merchantId, XSGD_AMOUNT, tokenIn, amountIn, uint40(block.timestamp + 15 minutes), door);
    }

    /// @dev Signs the payer's EIP-3009 authorization the way the payer page will:
    ///      to = GantryCore, nonce = intentId (unless a test deliberately deviates).
    function _signAuth(address token, uint256 value, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 digest = Eip3009Digest.transferDigest(token, payer, address(core), value, 0, validBefore, nonce);
        (v, r, s) = vm.sign(PAYER_PK, digest);
    }

    function _settleWithFreshSig(bytes32 intentId, address token, uint256 value) internal {
        (uint8 v, bytes32 r, bytes32 s) = _signAuth(token, value, block.timestamp + 1 hours, intentId);
        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);
    }
}
