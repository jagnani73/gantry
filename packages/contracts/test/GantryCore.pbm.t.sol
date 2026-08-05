// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GantryCore} from "../src/GantryCore.sol";
import {GantryTestBase} from "./helpers/GantryTestBase.sol";
import {MockPBMWallet, ReentrantPBMWallet} from "./helpers/MockPBMWallet.sol";

contract GantryCorePbmTest is GantryTestBase {
    MockPBMWallet internal wallet;

    uint256 internal constant EXPECTED_XSGD_OUT = 6_500_001;

    function setUp() public override {
        super.setUp();
        wallet = new MockPBMWallet();
        usdc.mint(address(wallet), 1_000e6);
    }

    function test_settleFromPBM_happy() public {
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Agent);

        vm.expectEmit(true, true, true, true, address(core));
        emit GantryCore.IntentSettled(
            intentId,
            merchantId,
            address(wallet),
            address(usdc),
            USDC_AMOUNT,
            EXPECTED_XSGD_OUT,
            0,
            GantryCore.Door.Agent
        );

        core.settleFromPBM(intentId, address(wallet), "");

        assertEq(xsgd.balanceOf(payout), EXPECTED_XSGD_OUT);
        assertEq(usdc.balanceOf(address(wallet)), 1_000e6 - USDC_AMOUNT);
        assertEq(uint8(core.getIntent(intentId).status), uint8(GantryCore.IntentStatus.Settled));
    }

    function test_revert_pbmWalletDoesNotPay() public {
        wallet.setMode(MockPBMWallet.Mode.Silent);
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Agent);

        vm.expectRevert(abi.encodeWithSelector(GantryCore.PBMPullFailed.selector, 0, USDC_AMOUNT));
        core.settleFromPBM(intentId, address(wallet), "");
    }

    function test_revert_pbmPolicyErrorBubblesOutOfCore() public {
        wallet.setMode(MockPBMWallet.Mode.RevertCategory);
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Agent);

        // The demo beat: an out-of-policy purchase dies as an on-chain revert whose
        // selector the facilitator can decode — not a backend if-statement.
        vm.expectRevert(
            abi.encodeWithSelector(MockPBMWallet.CategoryNotAllowed.selector, CATEGORY_FOOD_BEVERAGE)
        );
        core.settleFromPBM(intentId, address(wallet), "");
    }

    function test_revert_pbm_doubleSettle() public {
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Agent);
        core.settleFromPBM(intentId, address(wallet), "");

        vm.expectRevert(abi.encodeWithSelector(GantryCore.IntentAlreadySettled.selector, intentId));
        core.settleFromPBM(intentId, address(wallet), "");
    }

    function test_revert_pbm_expiredIntent() public {
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Agent);
        uint40 expiry = core.getIntent(intentId).expiry;
        vm.warp(uint256(expiry) + 1);

        vm.expectRevert(abi.encodeWithSelector(GantryCore.IntentExpired.selector, intentId, expiry));
        core.settleFromPBM(intentId, address(wallet), "");
    }

    function test_revert_pbm_humanDoorIntent() public {
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Human);

        vm.expectRevert(abi.encodeWithSelector(GantryCore.NotAgentIntent.selector, intentId));
        core.settleFromPBM(intentId, address(wallet), "");
    }

    function test_reentrancy_blockedOnPBMDoor_sameIntent() public {
        ReentrantPBMWallet reentrantWallet = new ReentrantPBMWallet(core);
        usdc.mint(address(reentrantWallet), 1_000e6);

        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Agent);
        reentrantWallet.setReentryIntentId(intentId);

        core.settleFromPBM(intentId, address(reentrantWallet), "");

        assertEq(reentrantWallet.reentryError(), GantryCore.Reentrancy.selector, "re-entry rejected by lock");
        assertEq(uint8(core.getIntent(intentId).status), uint8(GantryCore.IntentStatus.Settled));
    }

    function test_reentrancy_blockedOnPBMDoor_differentPendingIntent() public {
        ReentrantPBMWallet reentrantWallet = new ReentrantPBMWallet(core);
        usdc.mint(address(reentrantWallet), 1_000e6);

        bytes32 target = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Agent);
        bytes32 other = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Agent);
        reentrantWallet.setReentryIntentId(other);

        core.settleFromPBM(target, address(reentrantWallet), "");

        // The other intent is Pending and would pass every status check — only the lock
        // stands between the wallet and a mid-settlement second settlement.
        assertEq(reentrantWallet.reentryError(), GantryCore.Reentrancy.selector, "cross-intent re-entry rejected");
        assertEq(uint8(core.getIntent(other).status), uint8(GantryCore.IntentStatus.Pending));
    }

    function test_settleFromPBM_xsgdDirect() public {
        xsgd.mint(address(wallet), 1_000e6);
        vm.prank(relayer);
        bytes32 intentId = core.createIntent(
            merchantId, XSGD_AMOUNT, address(xsgd), XSGD_AMOUNT, uint40(block.timestamp + 15 minutes), GantryCore.Door.Agent
        );

        core.settleFromPBM(intentId, address(wallet), "");
        assertEq(xsgd.balanceOf(payout), XSGD_AMOUNT);
    }
}
