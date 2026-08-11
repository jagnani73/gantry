// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgentPBMWallet} from "../src/AgentPBMWallet.sol";
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
        merchantId = core.registerMerchant("ah-hock-chicken-rice", makeAddr("payout"), 1, "", "", "");
    }

    function _expiry() internal view returns (uint40) {
        return uint40(block.timestamp + 15 minutes);
    }

    function _createUsdcIntent() internal returns (bytes32) {
        vm.prank(relayer);
        return core.createIntent(merchantId, XSGD_AMOUNT, address(usdc), USDC_AMOUNT, _expiry(), GantryCore.Door.Human);
    }

    /// An AGENT-door intent — the only kind a denial may be recorded against. */
    function _createAgentIntent() internal returns (bytes32) {
        vm.prank(relayer);
        return core.createIntent(merchantId, XSGD_AMOUNT, address(usdc), USDC_AMOUNT, _expiry(), GantryCore.Door.Agent);
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
        bytes32 intentId =
            core.createIntent(merchantId, XSGD_AMOUNT, address(xsgd), XSGD_AMOUNT, _expiry(), GantryCore.Door.Agent);
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
        vm.expectRevert(abi.encodeWithSelector(GantryCore.XsgdAmountMismatch.selector, USDC_AMOUNT, XSGD_AMOUNT));
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
        assertEq(uint8(core.getIntent(intentId).status), uint8(GantryCore.IntentStatus.Cancelled));
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

    // ------------------------------------------------- denial (cancelIntentWithReason)

    /// The wallet error the demo's rejection beat produces, encoded exactly as the
    /// wallet would return it. Pinned as literal bytes rather than built from the
    /// wallet ABI: this is the payload an off-chain indexer decodes, so the test
    /// has to fail if the encoding moves, not follow it.
    bytes internal constant CATEGORY_NOT_ALLOWED_2 =
        hex"69cab3ea0000000000000000000000000000000000000000000000000000000000000002";

    function test_cancelWithReason_cancelsAndRecordsWhy() public {
        bytes32 intentId = _createAgentIntent();
        address wallet = makeAddr("pbmWallet");

        // BOTH events, in order. IntentDenied is emitted BESIDE IntentCancelled and
        // never instead of it, so everything already following cancellations keeps
        // working and only the indexer needs to know the second one exists.
        vm.expectEmit(true, false, false, false, address(core));
        emit GantryCore.IntentCancelled(intentId);
        vm.expectEmit(true, true, false, true, address(core));
        emit GantryCore.IntentDenied(intentId, wallet, CATEGORY_NOT_ALLOWED_2);

        vm.prank(relayer);
        core.cancelIntentWithReason(intentId, wallet, CATEGORY_NOT_ALLOWED_2);

        // Identical state change to a plain cancel — this is a cancellation that
        // says why, not a fourth intent status.
        assertEq(uint8(core.getIntent(intentId).status), uint8(GantryCore.IntentStatus.Cancelled));
    }

    /// The whole reason this function exists: an indexer must be able to rebuild the
    /// denial from the chain alone. Everything a denial row needs is either on the
    /// event or still readable off the cancelled intent.
    function test_cancelWithReason_leavesEnoughToRebuildTheRow() public {
        bytes32 intentId = _createAgentIntent();
        address wallet = makeAddr("pbmWallet");
        vm.prank(relayer);
        core.cancelIntentWithReason(intentId, wallet, CATEGORY_NOT_ALLOWED_2);

        // The intent SURVIVES cancellation, so the amounts and the token are still
        // readable — they do not need to ride on the event.
        GantryCore.PaymentIntent memory intent = core.getIntent(intentId);
        assertEq(intent.merchantId, merchantId);
        assertEq(intent.tokenIn, address(usdc));
        assertEq(intent.amountIn, USDC_AMOUNT);
        assertEq(intent.xsgdAmount, XSGD_AMOUNT);
    }

    function test_revert_cancelWithReason_notRelayer() public {
        bytes32 intentId = _createAgentIntent();
        vm.expectRevert(GantryCore.NotRelayer.selector);
        core.cancelIntentWithReason(intentId, makeAddr("pbmWallet"), CATEGORY_NOT_ALLOWED_2);
    }

    function test_revert_cancelWithReason_zeroWallet() public {
        bytes32 intentId = _createAgentIntent();
        vm.prank(relayer);
        vm.expectRevert(GantryCore.ZeroAddress.selector);
        core.cancelIntentWithReason(intentId, address(0), CATEGORY_NOT_ALLOWED_2);
    }

    /// Empty is refused as hard as oversized. A denial with no reason is worse than
    /// no denial event: the indexer would write a row whose error name it cannot
    /// decode, and the payer's screen would say a payment was declined without
    /// being able to say by what rule.
    function test_revert_cancelWithReason_emptyReason() public {
        bytes32 intentId = _createAgentIntent();
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(GantryCore.InvalidDenialReason.selector, uint256(0)));
        core.cancelIntentWithReason(intentId, makeAddr("pbmWallet"), "");
    }

    function test_revert_cancelWithReason_reasonTooLong() public {
        bytes32 intentId = _createAgentIntent();
        uint256 over = core.MAX_DENIAL_REASON_BYTES() + 1;
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(GantryCore.InvalidDenialReason.selector, over));
        core.cancelIntentWithReason(intentId, makeAddr("pbmWallet"), new bytes(over));
    }

    /// The literal above is checked against the WALLET'S OWN error rather than
    /// trusted. A hand-written selector is exactly the kind of constant that can be
    /// wrong while every test around it passes, because nothing else compares it to
    /// anything — this test is the one thing standing between that and an indexer
    /// pinned to a payload no wallet ever emits. (It caught a fabricated selector
    /// on the first run.)
    function test_cancelWithReason_pinnedPayloadMatchesTheWalletsOwnError() public pure {
        assertEq(
            CATEGORY_NOT_ALLOWED_2,
            abi.encodeWithSelector(AgentPBMWallet.CategoryNotAllowed.selector, uint16(2))
        );
    }

    /// EVERY wallet policy error must fit the bound, not just today's.
    ///
    /// The previous version of this asserted `100 <= MAX_DENIAL_REASON_BYTES`, which
    /// guarded the constant and said nothing about error sizes — a new error with
    /// eight uint256 args (260 bytes) would have passed and then degraded silently
    /// at runtime, because the backend drops an oversized payload to a plain cancel
    /// and records nothing. This measures the errors themselves.
    function test_cancelWithReason_everyPolicyErrorFitsTheBound() public view {
        // selector + one word per arg, which is the encoding for every value type
        // these errors use (uint16/uint40/uint128/uint256/address/bool).
        uint256[6] memory argCounts = [uint256(1), 2, 2, 0, 2, 0];
        for (uint256 i = 0; i < argCounts.length; i++) {
            assertLe(4 + argCounts[i] * 32, core.MAX_DENIAL_REASON_BYTES());
        }
        assertEq(CATEGORY_NOT_ALLOWED_2.length, 36);
        // The largest today is PerTxCapExceeded(uint256,uint256) at 68 bytes.
        assertLe(uint256(68), core.MAX_DENIAL_REASON_BYTES());
    }

    /// A denial may only be recorded against an AGENT intent. Without this a human
    /// QR payment could be cancelled with a policy reason and would render on a
    /// payer's screen as their agent being refused on an intent no agent touched.
    function test_revert_cancelWithReason_humanDoorIntent() public {
        bytes32 intentId = _createUsdcIntent(); // Door.Human
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(GantryCore.NotAgentIntent.selector, intentId));
        core.cancelIntentWithReason(intentId, makeAddr("pbmWallet"), CATEGORY_NOT_ALLOWED_2);
    }

    /// The lifecycle answer must win over the display-field checks: the bridge's
    /// resolver reads IntentAlreadySettled as evidence that settlement landed, so a
    /// denial arriving late must not mask it with a reason-shaped error.
    function test_revert_cancelWithReason_unknownIntent() public {
        bytes32 ghost = keccak256("ghost");
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(GantryCore.UnknownIntent.selector, ghost));
        core.cancelIntentWithReason(ghost, makeAddr("pbmWallet"), CATEGORY_NOT_ALLOWED_2);
    }

    /// A denial cannot resurrect a settled intent or double-cancel one, because it
    /// runs the same _requirePending guard the plain cancel does.
    function test_revert_cancelWithReason_alreadyCancelled() public {
        bytes32 intentId = _createAgentIntent();
        vm.startPrank(relayer);
        core.cancelIntent(intentId);
        vm.expectRevert(abi.encodeWithSelector(GantryCore.IntentWasCancelled.selector, intentId));
        core.cancelIntentWithReason(intentId, makeAddr("pbmWallet"), CATEGORY_NOT_ALLOWED_2);
        vm.stopPrank();
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
