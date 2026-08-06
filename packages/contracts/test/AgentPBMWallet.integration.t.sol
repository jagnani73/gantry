// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GantryCore} from "../src/GantryCore.sol";
import {AgentPBMWallet} from "../src/AgentPBMWallet.sol";
import {AgentPBMWalletFactory} from "../src/AgentPBMWalletFactory.sol";
import {GantryTestBase} from "./helpers/GantryTestBase.sol";
import {PbmDigest} from "./helpers/PbmDigest.sol";

/// @notice The real wallet settling through the real core — every binding error name is
///         proven THROUGH settleFromPBM (what the facilitator actually decodes), and the
///         demo's cap arithmetic is pinned with the exact on-chain numbers.
contract AgentPBMWalletIntegrationTest is GantryTestBase {
    AgentPBMWalletFactory internal factory;
    AgentPBMWallet internal wallet;

    uint256 internal constant AGENT_PK = 0xA6E27;
    address internal agent;

    bytes32 internal gadgetMerchantId;
    address internal gadgetPayout;

    // Demo policy: "S$50/day" at the pinned 1.3421 rate = ceil(50e6 * 1e6 / RATE) µUSDC.
    uint128 internal constant DEMO_CAP_USDC = 37_255_049;
    // S$19.50 team lunch and S$29 powerbank, same ceil-quote math the relayer applies.
    uint128 internal constant TEAM_LUNCH_XSGD = 19_500_000;
    uint128 internal constant TEAM_LUNCH_USDC = 14_529_469;
    uint128 internal constant POWERBANK_XSGD = 29_000_000;
    uint128 internal constant POWERBANK_USDC = 21_607_928;

    uint256 internal constant EXPECTED_XSGD_OUT = 6_500_001; // S$6.50 intent via swap

    function setUp() public override {
        super.setUp();
        agent = vm.addr(AGENT_PK);

        factory = new AgentPBMWalletFactory(address(core));
        vm.prank(relayer); // owner = relayer key, matching the demo deployment
        wallet = AgentPBMWallet(factory.createWallet(agent));

        vm.prank(relayer);
        wallet.setPolicy(_demoPolicy());
        usdc.mint(address(wallet), 1_000e6);

        gadgetPayout = makeAddr("gadgetPayout");
        gadgetMerchantId = core.registerMerchant("gadgethub-sg", gadgetPayout, 2);
    }

    function _demoPolicy() internal view returns (AgentPBMWallet.Policy memory) {
        return AgentPBMWallet.Policy({
            dailyCap: DEMO_CAP_USDC,
            perTxCap: DEMO_CAP_USDC,
            expiry: uint40(block.timestamp + 30 days),
            categoryBitmap: 1 << CATEGORY_FOOD_BEVERAGE
        });
    }

    function _createAgentIntent(bytes32 forMerchant, uint128 xsgdAmount, uint128 usdcAmount)
        internal
        returns (bytes32 intentId)
    {
        vm.prank(relayer);
        intentId = core.createIntent(
            forMerchant,
            xsgdAmount,
            address(usdc),
            usdcAmount,
            uint40(block.timestamp + 15 minutes),
            GantryCore.Door.Agent
        );
    }

    function _pbmSig(bytes32 intentId, address token, uint256 amount) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(AGENT_PK, PbmDigest.spendDigest(address(wallet), intentId, token, amount));
        return abi.encodePacked(r, s, v);
    }

    function _settleLunch(bytes32 salt) internal returns (bytes32 intentId) {
        intentId = _createAgentIntent(merchantId, TEAM_LUNCH_XSGD, TEAM_LUNCH_USDC);
        salt; // silence unused warning — distinct intents come from the core's nonce
        core.settleFromPBM(intentId, address(wallet), _pbmSig(intentId, address(usdc), TEAM_LUNCH_USDC));
    }

    // ---------------------------------------------------------------- happy paths

    function test_settleFromPBM_realWallet_happy() public {
        bytes32 intentId = _createAgentIntent(merchantId, XSGD_AMOUNT, USDC_AMOUNT);

        vm.expectEmit(true, true, true, true, address(wallet));
        emit AgentPBMWallet.SpendAuthorized(intentId, address(usdc), USDC_AMOUNT, USDC_AMOUNT);
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

        core.settleFromPBM(intentId, address(wallet), _pbmSig(intentId, address(usdc), USDC_AMOUNT));

        assertEq(xsgd.balanceOf(payout), EXPECTED_XSGD_OUT, "merchant paid in XSGD");
        assertEq(usdc.balanceOf(address(wallet)), 1_000e6 - USDC_AMOUNT, "wallet debited");
        assertEq(wallet.spentToday(), USDC_AMOUNT);
        assertEq(uint8(core.getIntent(intentId).status), uint8(GantryCore.IntentStatus.Settled));
    }

    function test_settleFromPBM_xsgdDirect_realWallet() public {
        xsgd.mint(address(wallet), 1_000e6);
        vm.prank(relayer);
        bytes32 intentId = core.createIntent(
            merchantId,
            XSGD_AMOUNT,
            address(xsgd),
            XSGD_AMOUNT,
            uint40(block.timestamp + 15 minutes),
            GantryCore.Door.Agent
        );

        core.settleFromPBM(intentId, address(wallet), _pbmSig(intentId, address(xsgd), XSGD_AMOUNT));

        assertEq(xsgd.balanceOf(payout), XSGD_AMOUNT, "XSGD-direct pays the merchant 1:1");
        assertEq(wallet.spentToday(), XSGD_AMOUNT);
    }

    // ---------------------------------------------------------------- the demo beats

    function test_settleFromPBM_categoryDenial_gadgetHub() public {
        bytes32 intentId = _createAgentIntent(gadgetMerchantId, POWERBANK_XSGD, POWERBANK_USDC);
        bytes memory sig = _pbmSig(intentId, address(usdc), POWERBANK_USDC);

        // THE money-shot beat: a S$29 powerbank at an electronics merchant dies as an
        // on-chain revert carrying the category — decodable by the facilitator, never a
        // backend if-statement.
        vm.expectRevert(abi.encodeWithSelector(AgentPBMWallet.CategoryNotAllowed.selector, uint16(2)));
        core.settleFromPBM(intentId, address(wallet), sig);

        assertEq(uint8(core.getIntent(intentId).status), uint8(GantryCore.IntentStatus.Pending), "intent untouched");
        assertEq(wallet.spentToday(), 0, "nothing counted against the cap");
    }

    function test_settleFromPBM_thirdTeamLunch_hitsDailyCap() public {
        _settleLunch("l1");
        _settleLunch("l2");
        assertEq(wallet.spentToday(), uint256(TEAM_LUNCH_USDC) * 2);

        // Third S$19.50 lunch: 43_588_407 attempted vs the 37_255_049 cap — the exact
        // failure ten rehearsals would hit without the setPolicy re-arm.
        bytes32 intentId = _createAgentIntent(merchantId, TEAM_LUNCH_XSGD, TEAM_LUNCH_USDC);
        bytes memory sig = _pbmSig(intentId, address(usdc), TEAM_LUNCH_USDC);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentPBMWallet.DailyCapExceeded.selector, uint256(TEAM_LUNCH_USDC) * 3, DEMO_CAP_USDC
            )
        );
        core.settleFromPBM(intentId, address(wallet), sig);
    }

    function test_setPolicy_reArmsRehearsal() public {
        _settleLunch("l1");
        _settleLunch("l2");

        // demo-reset's re-arm: same policy values, fresh window.
        vm.prank(relayer);
        wallet.setPolicy(_demoPolicy());
        assertEq(wallet.spentToday(), 0);

        _settleLunch("l3"); // would have reverted without the reset
        assertEq(wallet.spentToday(), TEAM_LUNCH_USDC);
    }

    function test_revoke_thenSettle_policyExpired() public {
        vm.prank(relayer);
        wallet.revoke();

        bytes32 intentId = _createAgentIntent(merchantId, TEAM_LUNCH_XSGD, TEAM_LUNCH_USDC);
        bytes memory sig = _pbmSig(intentId, address(usdc), TEAM_LUNCH_USDC);
        // The Revoke button beat: a revoked wallet refuses everything.
        vm.expectRevert(AgentPBMWallet.PolicyExpired.selector);
        core.settleFromPBM(intentId, address(wallet), sig);
    }

    // ---------------------------------------------------------------- error names through the core

    function test_settleFromPBM_wrongSignerBubbles() public {
        bytes32 intentId = _createAgentIntent(merchantId, XSGD_AMOUNT, USDC_AMOUNT);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(0xBAD, PbmDigest.spendDigest(address(wallet), intentId, address(usdc), USDC_AMOUNT));

        vm.expectRevert(AgentPBMWallet.InvalidAgentSignature.selector);
        core.settleFromPBM(intentId, address(wallet), abi.encodePacked(r, s, v));
    }

    function test_settleFromPBM_perTxDenialBubbles() public {
        vm.prank(relayer);
        wallet.setPolicy(
            AgentPBMWallet.Policy({
                dailyCap: DEMO_CAP_USDC,
                perTxCap: 10e6, // below the lunch amount
                expiry: uint40(block.timestamp + 30 days),
                categoryBitmap: 1 << CATEGORY_FOOD_BEVERAGE
            })
        );

        bytes32 intentId = _createAgentIntent(merchantId, TEAM_LUNCH_XSGD, TEAM_LUNCH_USDC);
        bytes memory sig = _pbmSig(intentId, address(usdc), TEAM_LUNCH_USDC);
        vm.expectRevert(abi.encodeWithSelector(AgentPBMWallet.PerTxCapExceeded.selector, TEAM_LUNCH_USDC, 10e6));
        core.settleFromPBM(intentId, address(wallet), sig);
    }

    function test_settleFromPBM_expiredPolicyBubbles() public {
        vm.prank(relayer);
        wallet.setPolicy(
            AgentPBMWallet.Policy({
                dailyCap: DEMO_CAP_USDC,
                perTxCap: DEMO_CAP_USDC,
                expiry: uint40(block.timestamp + 5 minutes),
                categoryBitmap: 1 << CATEGORY_FOOD_BEVERAGE
            })
        );
        bytes32 intentId = _createAgentIntent(merchantId, TEAM_LUNCH_XSGD, TEAM_LUNCH_USDC);
        bytes memory sig = _pbmSig(intentId, address(usdc), TEAM_LUNCH_USDC);

        vm.warp(block.timestamp + 6 minutes); // policy expired, intent (15 min) still alive
        vm.expectRevert(AgentPBMWallet.PolicyExpired.selector);
        core.settleFromPBM(intentId, address(wallet), sig);
    }

    function test_settleFromPBM_walletUnderfunded_insufficientWalletBalance() public {
        vm.prank(relayer);
        wallet.withdraw(address(usdc), relayer, 1_000e6 - 1e6); // leave 1 USDC

        bytes32 intentId = _createAgentIntent(merchantId, XSGD_AMOUNT, USDC_AMOUNT);
        bytes memory sig = _pbmSig(intentId, address(usdc), USDC_AMOUNT);
        // The wallet's own pre-check fires — deterministic, not PBMPullFailed and not
        // whatever shape the token would revert with.
        vm.expectRevert(abi.encodeWithSelector(AgentPBMWallet.InsufficientWalletBalance.selector, 1e6, USDC_AMOUNT));
        core.settleFromPBM(intentId, address(wallet), sig);
    }

    function test_settleFromPBM_replayBlockedByCore() public {
        bytes32 intentId = _createAgentIntent(merchantId, XSGD_AMOUNT, USDC_AMOUNT);
        bytes memory sig = _pbmSig(intentId, address(usdc), USDC_AMOUNT);
        core.settleFromPBM(intentId, address(wallet), sig);

        // The wallet holds no per-intent ledger — THIS is the replay guard it trusts:
        // the core flipped the intent to Settled before ever calling the wallet.
        vm.expectRevert(abi.encodeWithSelector(GantryCore.IntentAlreadySettled.selector, intentId));
        core.settleFromPBM(intentId, address(wallet), sig);
        assertEq(wallet.spentToday(), USDC_AMOUNT, "second attempt never reached the wallet");
    }
}
