// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GantryCore} from "../../src/GantryCore.sol";
import {AgentPBMWallet} from "../../src/AgentPBMWallet.sol";
import {AgentPBMWalletFactory} from "../../src/AgentPBMWalletFactory.sol";
import {FixedRateSwap} from "../../src/FixedRateSwap.sol";
import {MockXSGD} from "../../src/mocks/MockXSGD.sol";
import {PbmDigest} from "../helpers/PbmDigest.sol";

/// @notice Fork test: the AgentPBMWallet pushing REAL Circle USDC through settleFromPBM.
///         The wallet's EIP-712 layer is our own code (unit-covered); what only a fork
///         can retire is the SafeERC20 push of FiatTokenV2_2 wallet → core → swap.
///         Denial paths never touch the token, so they carry zero fork-specific risk and
///         stay in the unit/integration suites. Self-skipping without BASE_SEPOLIA_RPC_URL.
contract PbmWalletForkTest is Test {
    address internal constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    GantryCore internal core;
    MockXSGD internal xsgd;
    FixedRateSwap internal swap;
    AgentPBMWalletFactory internal factory;
    AgentPBMWallet internal wallet;

    uint256 internal constant AGENT_PK = 0xA6E27;
    address internal agent;
    address internal relayer;
    address internal payout;
    bytes32 internal merchantId;

    uint128 internal constant XSGD_AMOUNT = 6_500_000;
    uint128 internal constant USDC_AMOUNT = 4_843_157;
    uint256 internal constant RATE = 1_342_100;
    uint128 internal constant DEMO_CAP_USDC = 37_255_049;

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

        agent = vm.addr(AGENT_PK);
        relayer = makeAddr("relayer");
        payout = makeAddr("payout");

        xsgd = new MockXSGD();
        swap = new FixedRateSwap(IERC20(address(xsgd)));
        swap.setRate(USDC, RATE);
        xsgd.mint(address(swap), 1_000_000e6);
        core = new GantryCore(IERC20(address(xsgd)), relayer);
        core.setSwap(swap);
        merchantId = core.registerMerchant("ah-hock-chicken-rice", payout, 1);

        factory = new AgentPBMWalletFactory(address(core));
        wallet = AgentPBMWallet(factory.createWallet(agent, "")); // this test contract owns it
        wallet.setPolicy(
            AgentPBMWallet.Policy({
                dailyCap: DEMO_CAP_USDC,
                perTxCap: DEMO_CAP_USDC,
                expiry: uint40(block.timestamp + 30 days),
                categoryBitmap: 1 << 1
            })
        );

        // Same top-bit caveat as RealUsdcFork: deal() writes a plain balance, which
        // FiatTokenV2_2 reads as unblacklisted.
        deal(USDC, address(wallet), 100e6);
        assertEq(IERC20(USDC).balanceOf(address(wallet)), 100e6, "deal() must fund the wallet on the fork");
    }

    function test_fork_settleFromPBM_realUsdc() public forked {
        vm.prank(relayer);
        bytes32 intentId = core.createIntent(
            merchantId, XSGD_AMOUNT, USDC, USDC_AMOUNT, uint40(block.timestamp + 15 minutes), GantryCore.Door.Agent
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(AGENT_PK, PbmDigest.spendDigest(address(wallet), intentId, USDC, USDC_AMOUNT));

        core.settleFromPBM(intentId, address(wallet), abi.encodePacked(r, s, v));

        assertEq(xsgd.balanceOf(payout), 6_500_001, "merchant paid in XSGD");
        assertEq(IERC20(USDC).balanceOf(address(wallet)), 100e6 - USDC_AMOUNT, "real USDC pushed out of the wallet");
        assertEq(wallet.spentToday(), USDC_AMOUNT);
        assertEq(uint8(core.getIntent(intentId).status), uint8(GantryCore.IntentStatus.Settled));
    }
}
