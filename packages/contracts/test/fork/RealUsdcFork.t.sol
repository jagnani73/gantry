// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GantryCore} from "../../src/GantryCore.sol";
import {FixedRateSwap} from "../../src/FixedRateSwap.sol";
import {MockXSGD} from "../../src/mocks/MockXSGD.sol";
import {IERC3009} from "../../src/interfaces/IERC3009.sol";
import {Eip3009Digest} from "../helpers/Eip3009Digest.sol";

/// @notice Fork tests against REAL Circle USDC on Base Sepolia. EIP-3009 domain/signature
///         quirks vs the live FiatTokenV2_2 are a known project risk — these tests retire
///         it by signing with the exact same Eip3009Digest helper the unit tests use.
///         Self-skipping: without BASE_SEPOLIA_RPC_URL every test is skipped, so plain
///         `forge test` stays green offline.
contract RealUsdcForkTest is Test {
    address internal constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    uint256 internal constant BASE_SEPOLIA_CHAIN_ID = 84532;

    GantryCore internal core;
    MockXSGD internal xsgd;
    FixedRateSwap internal swap;

    uint256 internal constant PAYER_PK = 0xA11CE;
    address internal payer;
    address internal relayer;
    address internal payout;
    bytes32 internal merchantId;

    uint128 internal constant XSGD_AMOUNT = 6_500_000;
    uint128 internal constant USDC_AMOUNT = 4_843_157;
    uint256 internal constant RATE = 1_342_100;

    bool internal forkEnabled;

    modifier forked() {
        if (!forkEnabled) {
            vm.skip(true);
        }
        _;
    }

    function setUp() public {
        string memory rpc = vm.envOr("BASE_SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forkEnabled = true;

        payer = vm.addr(PAYER_PK);
        relayer = makeAddr("relayer");
        payout = makeAddr("payout");

        xsgd = new MockXSGD();
        swap = new FixedRateSwap(IERC20(address(xsgd)));
        swap.setRate(USDC, RATE);
        xsgd.mint(address(swap), 1_000_000e6);
        core = new GantryCore(IERC20(address(xsgd)), relayer);
        core.setSwap(swap);
        merchantId = core.registerMerchant("ah-hock-chicken-rice", payout, 1);

        // FiatTokenV2_2 packs a blacklist flag into the top bit of the balance slot;
        // deal() writes the plain amount (top bit 0), which is a valid unblacklisted
        // balance. If stdstore ever fails to find the slot, fall back to Circle's
        // faucet funding vm.addr(PAYER_PK) — every signature here recovers to that
        // address, so funding any other account would only produce InvalidSignature.
        deal(USDC, payer, 100e6);
        assertEq(IERC20(USDC).balanceOf(payer), 100e6, "deal() must fund the payer on the fork");
    }

    function _createIntent() internal returns (bytes32 intentId) {
        vm.prank(relayer);
        intentId = core.createIntent(
            merchantId, XSGD_AMOUNT, USDC, USDC_AMOUNT, uint40(block.timestamp + 15 minutes), GantryCore.Door.Human
        );
    }

    function test_fork_domainSeparator_matchesUsdcV2() public forked {
        // Documents the live values ("USDC", "2") the payer page must use. If Circle
        // ever bumps the version this fails loudly while settlement keeps working
        // (the digest helper reads the live separator).
        bytes32 expected = Eip3009Digest.domainSeparator("USDC", "2", BASE_SEPOLIA_CHAIN_ID, USDC);
        assertEq(IERC3009(USDC).DOMAIN_SEPARATOR(), expected);
    }

    function test_fork_settleAuth_happyPath_realUsdc() public forked {
        bytes32 intentId = _createIntent();
        bytes32 digest = Eip3009Digest.transferDigest(
            USDC, payer, address(core), USDC_AMOUNT, 0, block.timestamp + 1 hours, intentId
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_PK, digest);

        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);

        assertEq(xsgd.balanceOf(payout), 6_500_001, "merchant paid in XSGD");
        assertEq(IERC20(USDC).balanceOf(payer), 100e6 - USDC_AMOUNT);
        assertTrue(IERC3009(USDC).authorizationState(payer, intentId), "intentId consumed as nonce on real USDC");
        assertEq(uint8(core.getIntent(intentId).status), uint8(GantryCore.IntentStatus.Settled));
    }

    function test_fork_revert_nonceReplayOnRealToken() public forked {
        bytes32 intentId = _createIntent();
        bytes32 digest = Eip3009Digest.transferDigest(
            USDC, payer, address(core), USDC_AMOUNT, 0, block.timestamp + 1 hours, intentId
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_PK, digest);
        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);

        // Even if the intent guard were bypassed, the token itself refuses a second use.
        // The pinned message proves the revert is FOR nonce consumption, not e.g. an
        // unfunded payer; if Circle rewords it, post-state asserts below still hold.
        uint256 balanceBefore = IERC20(USDC).balanceOf(payer);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        IERC3009(USDC)
            .transferWithAuthorization(
                payer, address(core), USDC_AMOUNT, 0, block.timestamp + 1 hours, intentId, v, r, s
            );
        assertEq(IERC20(USDC).balanceOf(payer), balanceBefore, "replay must move nothing");
    }

    function test_fork_revert_wrongDomain_signature() public forked {
        bytes32 intentId = _createIntent();
        // Sign over a bogus domain (mock-style name/version) — real USDC must reject it.
        bytes32 bogusSeparator = Eip3009Digest.domainSeparator("Mock USDC", "1", BASE_SEPOLIA_CHAIN_ID, USDC);
        bytes32 structHash = keccak256(
            abi.encode(
                Eip3009Digest.TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                payer,
                address(core),
                uint256(USDC_AMOUNT),
                uint256(0),
                block.timestamp + 1 hours,
                intentId
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", bogusSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_PK, digest);

        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);

        // Pin the reason via post-state too: the authorization is untouched and the
        // intent still Pending — the revert wasn't expiry or a funding problem.
        assertFalse(IERC3009(USDC).authorizationState(payer, intentId));
        assertEq(uint8(core.getIntent(intentId).status), uint8(GantryCore.IntentStatus.Pending));
    }
}
