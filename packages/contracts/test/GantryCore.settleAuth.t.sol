// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GantryCore} from "../src/GantryCore.sol";
import {FixedRateSwap} from "../src/FixedRateSwap.sol";
import {EIP3009} from "../src/mocks/EIP3009.sol";
import {GantryTestBase} from "./helpers/GantryTestBase.sol";
import {LyingSwap, ReentrantSwap} from "./helpers/BadSwaps.sol";

contract GantryCoreSettleAuthTest is GantryTestBase {
    // 4_843_157 USDC-units * 1_342_100 / 1e6, floored
    uint256 internal constant EXPECTED_XSGD_OUT = 6_500_001;

    function test_settleAuth_happyPath_usdcSwappedToXsgd() public {
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Human);
        (uint8 v, bytes32 r, bytes32 s) = _signAuth(address(usdc), USDC_AMOUNT, block.timestamp + 1 hours, intentId);

        vm.expectEmit(true, true, true, true, address(core));
        emit GantryCore.IntentSettled(
            intentId, merchantId, payer, address(usdc), USDC_AMOUNT, EXPECTED_XSGD_OUT, 0, GantryCore.Door.Human
        );

        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);

        assertEq(xsgd.balanceOf(payout), EXPECTED_XSGD_OUT, "merchant paid in XSGD at pool rate");
        assertGe(xsgd.balanceOf(payout), XSGD_AMOUNT, "merchant never receives less than the price");
        assertEq(usdc.balanceOf(payer), 1_000e6 - USDC_AMOUNT);
        assertEq(usdc.balanceOf(address(core)), 0, "no USDC strands in the core");
        assertEq(uint8(core.getIntent(intentId).status), uint8(GantryCore.IntentStatus.Settled));
        assertTrue(usdc.authorizationState(payer, intentId), "intentId consumed as the EIP-3009 nonce");
    }

    function test_settleAuth_happyPath_xsgdDirect_skipsSwap() public {
        bytes32 intentId = _createIntent(address(xsgd), XSGD_AMOUNT, GantryCore.Door.Human);
        uint256 swapBalanceBefore = xsgd.balanceOf(address(swap));

        _settleWithFreshSig(intentId, address(xsgd), XSGD_AMOUNT);

        assertEq(xsgd.balanceOf(payout), XSGD_AMOUNT);
        assertEq(xsgd.balanceOf(address(swap)), swapBalanceBefore, "swap untouched for XSGD-direct");
    }

    function test_settleAuth_permissionlessSubmitter() public {
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Human);
        (uint8 v, bytes32 r, bytes32 s) = _signAuth(address(usdc), USDC_AMOUNT, block.timestamp + 1 hours, intentId);

        vm.prank(makeAddr("anyone"));
        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);
        assertEq(xsgd.balanceOf(payout), EXPECTED_XSGD_OUT);
    }

    function test_revert_nonceNotIntentId() public {
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Human);
        // Payer signs a perfectly valid authorization — but over a different nonce.
        // The core always submits nonce = intentId, so the signature cannot match.
        (uint8 v, bytes32 r, bytes32 s) =
            _signAuth(address(usdc), USDC_AMOUNT, block.timestamp + 1 hours, keccak256("some-other-nonce"));

        vm.expectRevert(EIP3009.InvalidSignature.selector);
        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);
    }

    function test_revert_signedWrongAmount() public {
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Human);
        (uint8 v, bytes32 r, bytes32 s) = _signAuth(address(usdc), USDC_AMOUNT - 1, block.timestamp + 1 hours, intentId);

        vm.expectRevert(EIP3009.InvalidSignature.selector);
        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);
    }

    function test_revert_signedWrongRecipient() public {
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Human);
        // Recipient in the typed data is the attacker, not the core.
        bytes32 digest = _digestWithRecipient(makeAddr("attacker"), intentId);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_PK, digest);

        vm.expectRevert(EIP3009.InvalidSignature.selector);
        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);
    }

    function test_revert_doubleSettle() public {
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Human);
        _settleWithFreshSig(intentId, address(usdc), USDC_AMOUNT);

        (uint8 v, bytes32 r, bytes32 s) = _signAuth(address(usdc), USDC_AMOUNT, block.timestamp + 1 hours, intentId);
        vm.expectRevert(abi.encodeWithSelector(GantryCore.IntentAlreadySettled.selector, intentId));
        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);
    }

    function test_revert_intentExpired() public {
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Human);
        uint40 expiry = core.getIntent(intentId).expiry;
        vm.warp(uint256(expiry) + 1);

        (uint8 v, bytes32 r, bytes32 s) = _signAuth(address(usdc), USDC_AMOUNT, block.timestamp + 1 hours, intentId);
        vm.expectRevert(abi.encodeWithSelector(GantryCore.IntentExpired.selector, intentId, expiry));
        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);
    }

    function test_revert_cancelledIntent() public {
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Human);
        vm.prank(relayer);
        core.cancelIntent(intentId);

        (uint8 v, bytes32 r, bytes32 s) = _signAuth(address(usdc), USDC_AMOUNT, block.timestamp + 1 hours, intentId);
        vm.expectRevert(abi.encodeWithSelector(GantryCore.IntentWasCancelled.selector, intentId));
        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);
    }

    function test_revert_unknownIntent() public {
        bytes32 ghost = keccak256("ghost");
        vm.expectRevert(abi.encodeWithSelector(GantryCore.UnknownIntent.selector, ghost));
        core.settleWithAuthorization(ghost, payer, 0, block.timestamp + 1 hours, 0, bytes32(0), bytes32(0));
    }

    function test_revert_authWindowExpired() public {
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Human);
        uint256 validBefore = block.timestamp; // token requires strictly less than
        (uint8 v, bytes32 r, bytes32 s) = _signAuth(address(usdc), USDC_AMOUNT, validBefore, intentId);

        vm.expectRevert(EIP3009.AuthorizationExpired.selector);
        core.settleWithAuthorization(intentId, payer, 0, validBefore, v, r, s);
    }

    function test_revert_swapNotSet_beforeFundsPulled() public {
        core.setSwap(FixedRateSwap(address(0)));
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Human);
        (uint8 v, bytes32 r, bytes32 s) = _signAuth(address(usdc), USDC_AMOUNT, block.timestamp + 1 hours, intentId);

        vm.expectRevert(GantryCore.SwapNotSet.selector);
        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);

        assertFalse(usdc.authorizationState(payer, intentId), "authorization must stay unused");
        assertEq(usdc.balanceOf(payer), 1_000e6, "no funds pulled");
    }

    function test_revert_insufficientRate_swapGuardFires() public {
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Human);
        swap.setRate(address(usdc), 1_000_000); // 1:1 — output 4.84 XSGD < 6.50 price
        (uint8 v, bytes32 r, bytes32 s) = _signAuth(address(usdc), USDC_AMOUNT, block.timestamp + 1 hours, intentId);

        vm.expectRevert(abi.encodeWithSelector(FixedRateSwap.InsufficientOutput.selector, USDC_AMOUNT, XSGD_AMOUNT));
        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);
    }

    function test_revert_lyingSwap_balanceDeltaGuardFires() public {
        LyingSwap lyingSwap = new LyingSwap(IERC20(address(xsgd)));
        xsgd.mint(address(lyingSwap), 1_000_000e6);
        core.setSwap(lyingSwap);

        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Human);
        (uint8 v, bytes32 r, bytes32 s) = _signAuth(address(usdc), USDC_AMOUNT, block.timestamp + 1 hours, intentId);

        vm.expectRevert(abi.encodeWithSelector(GantryCore.InsufficientXsgdOut.selector, XSGD_AMOUNT - 1, XSGD_AMOUNT));
        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);
    }

    function test_reentrancy_blocked() public {
        ReentrantSwap reentrantSwap = new ReentrantSwap(core, IERC20(address(xsgd)));
        xsgd.mint(address(reentrantSwap), 1_000_000e6);
        core.setSwap(reentrantSwap);

        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Human);
        reentrantSwap.setReentryIntentId(intentId);
        _settleWithFreshSig(intentId, address(usdc), USDC_AMOUNT);

        assertEq(reentrantSwap.reentryError(), GantryCore.Reentrancy.selector, "re-entry rejected by lock");
        assertEq(uint8(core.getIntent(intentId).status), uint8(GantryCore.IntentStatus.Settled));
    }

    function test_griefing_directTokenFrontrun_thenRescue() public {
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Human);
        (uint8 v, bytes32 r, bytes32 s) = _signAuth(address(usdc), USDC_AMOUNT, block.timestamp + 1 hours, intentId);

        // Observer replays the raw signature straight against the token: funds land in
        // the core without settling the intent.
        vm.prank(makeAddr("frontrunner"));
        usdc.transferWithAuthorization(
            payer, address(core), USDC_AMOUNT, 0, block.timestamp + 1 hours, intentId, v, r, s
        );
        assertEq(usdc.balanceOf(address(core)), USDC_AMOUNT);

        // Settlement now reverts inside the token — authorization already used.
        vm.expectRevert(abi.encodeWithSelector(EIP3009.AuthorizationAlreadyUsed.selector, payer, intentId));
        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);

        // The intent survives the griefing untouched, so the relayer can still clean up.
        assertEq(uint8(core.getIntent(intentId).status), uint8(GantryCore.IntentStatus.Pending));

        // Owner sweeps the stranded funds to refund the payer.
        core.rescueERC20(address(usdc), payer, USDC_AMOUNT);
        assertEq(usdc.balanceOf(payer), 1_000e6);
        assertEq(usdc.balanceOf(address(core)), 0);

        vm.prank(relayer);
        core.cancelIntent(intentId);
    }

    function test_settleAuth_agentDoorIntent_x402Exact() public {
        // The x402 `exact` scheme IS an agent paying through the authorization door —
        // this pairing must never be blocked by a door check on this entry point.
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Agent);
        (uint8 v, bytes32 r, bytes32 s) = _signAuth(address(usdc), USDC_AMOUNT, block.timestamp + 1 hours, intentId);

        vm.expectEmit(true, true, true, true, address(core));
        emit GantryCore.IntentSettled(
            intentId, merchantId, payer, address(usdc), USDC_AMOUNT, EXPECTED_XSGD_OUT, 0, GantryCore.Door.Agent
        );
        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);
    }

    function test_settleAuth_atExactExpiry_allowed() public {
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Human);
        vm.warp(uint256(core.getIntent(intentId).expiry)); // exactly the boundary second
        _settleWithFreshSig(intentId, address(usdc), USDC_AMOUNT);
        assertEq(uint8(core.getIntent(intentId).status), uint8(GantryCore.IntentStatus.Settled));
    }

    function test_settleAuth_xsgdDirect_worksWithSwapUnset() public {
        core.setSwap(FixedRateSwap(address(0)));
        bytes32 intentId = _createIntent(address(xsgd), XSGD_AMOUNT, GantryCore.Door.Human);
        _settleWithFreshSig(intentId, address(xsgd), XSGD_AMOUNT);
        assertEq(xsgd.balanceOf(payout), XSGD_AMOUNT);
    }

    function test_revert_cancelAfterSettle() public {
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Human);
        _settleWithFreshSig(intentId, address(usdc), USDC_AMOUNT);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(GantryCore.IntentAlreadySettled.selector, intentId));
        core.cancelIntent(intentId);
    }

    function test_settleAuth_feeSkimmed() public {
        address feeSink = makeAddr("feeSink");
        core.setFee(50, feeSink); // 0.5%
        bytes32 intentId = _createIntent(address(usdc), USDC_AMOUNT, GantryCore.Door.Human);
        (uint8 v, bytes32 r, bytes32 s) = _signAuth(address(usdc), USDC_AMOUNT, block.timestamp + 1 hours, intentId);

        uint256 expectedFee = (EXPECTED_XSGD_OUT * 50) / 10_000; // 32_500

        vm.expectEmit(true, true, true, true, address(core));
        emit GantryCore.IntentSettled(
            intentId,
            merchantId,
            payer,
            address(usdc),
            USDC_AMOUNT,
            EXPECTED_XSGD_OUT,
            expectedFee,
            GantryCore.Door.Human
        );
        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);

        assertEq(xsgd.balanceOf(feeSink), expectedFee);
        assertEq(xsgd.balanceOf(payout), EXPECTED_XSGD_OUT - expectedFee);
    }

    function test_revert_setFee_tooHigh() public {
        vm.expectRevert(abi.encodeWithSelector(GantryCore.FeeTooHigh.selector, uint16(201)));
        core.setFee(201, makeAddr("feeSink"));
    }

    function test_revert_setFee_nonZeroBpsNeedsRecipient() public {
        vm.expectRevert(GantryCore.ZeroAddress.selector);
        core.setFee(50, address(0));
    }

    function test_revert_adminFunctions_notOwner() public {
        address rando = makeAddr("rando");
        vm.startPrank(rando);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando));
        core.setSwap(swap);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando));
        core.rescueERC20(address(usdc), rando, 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando));
        core.setFee(50, rando);
        vm.stopPrank();
    }

    function test_revert_setRelayer_zeroAddress() public {
        vm.expectRevert(GantryCore.ZeroAddress.selector);
        core.setRelayer(address(0));
    }

    function test_renounceOwnership_disabled() public {
        vm.expectRevert(GantryCore.OwnershipCannotBeRenounced.selector);
        core.renounceOwnership();
    }

    function test_ownershipTransfer_isTwoStep() public {
        address newOwner = makeAddr("newOwner");
        core.transferOwnership(newOwner);
        assertEq(core.owner(), address(this), "ownership must not move before acceptance");
        vm.prank(newOwner);
        core.acceptOwnership();
        assertEq(core.owner(), newOwner);
    }

    function _digestWithRecipient(address to, bytes32 nonce) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
                payer,
                to,
                uint256(USDC_AMOUNT),
                uint256(0),
                block.timestamp + 1 hours,
                nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
    }
}
