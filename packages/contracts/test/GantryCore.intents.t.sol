// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GantryCore} from "../src/GantryCore.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockXSGD} from "../src/mocks/MockXSGD.sol";

contract GantryCoreIntentsTest is Test {
    GantryCore internal core;
    MockUSDC internal usdc;
    MockXSGD internal xsgd;

    address internal relayer;
    bytes32 internal merchantId;

    uint128 internal constant XSGD_AMOUNT = 6_500_000; // S$6.50
    uint128 internal constant USDC_AMOUNT = 4_843_157; // ceil(6.50 / 1.3421), 6dp

    function setUp() public {
        vm.warp(1_755_000_000);
        relayer = makeAddr("relayer");
        usdc = new MockUSDC();
        xsgd = new MockXSGD();
        core = new GantryCore(IERC20(address(xsgd)), relayer);
        merchantId = core.registerMerchant("ah-hock-chicken-rice", makeAddr("payout"), 1);
    }

    function _expiry() internal view returns (uint40) {
        return uint40(block.timestamp + 15 minutes);
    }

    function _createUsdcIntent() internal returns (bytes32) {
        vm.prank(relayer);
        return core.createIntent(
            merchantId, XSGD_AMOUNT, address(usdc), USDC_AMOUNT, _expiry(), GantryCore.Door.Human
        );
    }

    function test_createIntent_happy() public {
        bytes32 intentId = _createUsdcIntent();

        GantryCore.PaymentIntent memory intent = core.getIntent(intentId);
        assertEq(intent.merchantId, merchantId);
        assertEq(intent.tokenIn, address(usdc));
        assertEq(intent.xsgdAmount, XSGD_AMOUNT);
        assertEq(intent.amountIn, USDC_AMOUNT);
        assertEq(intent.expiry, _expiry());
        assertEq(uint8(intent.status), uint8(GantryCore.IntentStatus.Pending));
        assertEq(uint8(intent.door), uint8(GantryCore.Door.Human));
    }

    function test_createIntent_emitsEvent() public {
        bytes32 expectedId = keccak256(abi.encode(block.chainid, address(core), merchantId, uint256(0)));

        vm.expectEmit(true, true, false, true, address(core));
        emit GantryCore.IntentCreated(
            expectedId, merchantId, address(usdc), USDC_AMOUNT, XSGD_AMOUNT, _expiry(), GantryCore.Door.Human
        );
        _createUsdcIntent();
    }

    function test_createIntent_idsAreUniqueAndDeterministic() public {
        bytes32 first = _createUsdcIntent();
        bytes32 second = _createUsdcIntent();

        assertTrue(first != second);
        assertEq(first, keccak256(abi.encode(block.chainid, address(core), merchantId, uint256(0))));
        assertEq(second, keccak256(abi.encode(block.chainid, address(core), merchantId, uint256(1))));
    }

    function test_createIntent_xsgdDirect_amountsMustMatch() public {
        vm.prank(relayer);
        bytes32 intentId = core.createIntent(
            merchantId, XSGD_AMOUNT, address(xsgd), XSGD_AMOUNT, _expiry(), GantryCore.Door.Agent
        );
        assertEq(uint8(core.getIntent(intentId).door), uint8(GantryCore.Door.Agent));
    }

    function test_revert_create_notRelayer() public {
        vm.expectRevert(GantryCore.NotRelayer.selector);
        core.createIntent(merchantId, XSGD_AMOUNT, address(usdc), USDC_AMOUNT, _expiry(), GantryCore.Door.Human);
    }

    function test_revert_create_unknownMerchant() public {
        bytes32 ghost = keccak256("ghost");
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(GantryCore.MerchantNotFound.selector, ghost));
        core.createIntent(ghost, XSGD_AMOUNT, address(usdc), USDC_AMOUNT, _expiry(), GantryCore.Door.Human);
    }

    function test_revert_create_zeroAmounts() public {
        vm.startPrank(relayer);
        vm.expectRevert(GantryCore.ZeroAmount.selector);
        core.createIntent(merchantId, 0, address(usdc), USDC_AMOUNT, _expiry(), GantryCore.Door.Human);
        vm.expectRevert(GantryCore.ZeroAmount.selector);
        core.createIntent(merchantId, XSGD_AMOUNT, address(usdc), 0, _expiry(), GantryCore.Door.Human);
        vm.stopPrank();
    }

    function test_revert_create_pastExpiry() public {
        uint40 stale = uint40(block.timestamp);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(GantryCore.BadExpiry.selector, stale));
        core.createIntent(merchantId, XSGD_AMOUNT, address(usdc), USDC_AMOUNT, stale, GantryCore.Door.Human);
    }

    function test_revert_create_xsgdAmountMismatch() public {
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(GantryCore.XsgdAmountMismatch.selector, USDC_AMOUNT, XSGD_AMOUNT)
        );
        core.createIntent(merchantId, XSGD_AMOUNT, address(xsgd), USDC_AMOUNT, _expiry(), GantryCore.Door.Human);
    }

    function test_cancelIntent_happy() public {
        bytes32 intentId = _createUsdcIntent();

        vm.expectEmit(true, false, false, false, address(core));
        emit GantryCore.IntentCancelled(intentId);

        vm.prank(relayer);
        core.cancelIntent(intentId);
        assertEq(uint8(core.getIntent(intentId).status), uint8(GantryCore.IntentStatus.Cancelled));
    }

    function test_cancel_allowedAfterExpiry() public {
        bytes32 intentId = _createUsdcIntent();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(relayer);
        core.cancelIntent(intentId);
    }

    function test_revert_cancel_notRelayer() public {
        bytes32 intentId = _createUsdcIntent();
        vm.expectRevert(GantryCore.NotRelayer.selector);
        core.cancelIntent(intentId);
    }

    function test_revert_cancel_unknownIntent() public {
        bytes32 ghost = keccak256("ghost");
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(GantryCore.UnknownIntent.selector, ghost));
        core.cancelIntent(ghost);
    }

    function test_revert_cancel_alreadyCancelled() public {
        bytes32 intentId = _createUsdcIntent();
        vm.startPrank(relayer);
        core.cancelIntent(intentId);
        vm.expectRevert(abi.encodeWithSelector(GantryCore.IntentWasCancelled.selector, intentId));
        core.cancelIntent(intentId);
        vm.stopPrank();
    }
}
