// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GantryCore} from "../src/GantryCore.sol";
import {FixedRateSwap} from "../src/FixedRateSwap.sol";
import {IGantrySwap} from "../src/interfaces/IGantrySwap.sol";
import {MockXSGD} from "../src/mocks/MockXSGD.sol";
import {AgentPBMWalletFactory} from "../src/AgentPBMWalletFactory.sol";

/**
 * @notice The whole rail, deployed in ONE run so it has ONE start block.
 *
 * @dev    This exists because the deployments had drifted apart in time: GantryCore and
 *         the agent factory sat ~229k blocks apart, which forced two indexing floors,
 *         two scans over overlapping block ranges, and a backend that could not simply
 *         say "read the chain from here". Deploying together collapses that to a single
 *         `BASE_SEPOLIA_DEPLOY_BLOCK`, which is what lets `WalletCreated` fold into the
 *         indexer's own sweep instead of carrying a second scanner.
 *
 *         MockUSDC is deliberately NOT deployed. Every door settles in real Circle USDC;
 *         the mock survives only as the Foundry suite's EIP-3009 test double and has been
 *         out of `addresses.ts` since 8 Aug 2026. Deploying it again would put a second
 *         USDC-looking address in front of an operator mid-demo.
 *
 *         Run:
 *           forge script script/DeployAll.s.sol --rpc-url base_sepolia --broadcast --verify
 *         Prefer `pnpm contracts:fresh`, which sweeps funds out of the wallets this
 *         orphans, runs this, and writes the addresses into shared for you.
 *
 *         EVERY address changes and every registered merchant is gone — handles are
 *         claimed per-core, so `demo:reset` re-registers the demo shops afterwards.
 */
contract DeployAll is Script {
    address internal constant REAL_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address internal constant REAL_EURC = 0x808456652fdb597867f38412077A9182bf77359F;
    uint256 internal constant DEMO_RATE = 1_342_100; // 1.3421 XSGD per USDC, 6dp
    uint256 internal constant DEMO_RATE_EURC = 1_510_000; // 1.5100 XSGD per EURC, 6dp
    uint256 internal constant SWAP_LIQUIDITY = 1_000_000e6; // 1M XSGD
    uint16 internal constant FEE_BPS = 50; // 0.5% — the fee story shown in the demo

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        // The block BEFORE anything is broadcast, so the floor can only under-state.
        // Under-stating costs a few empty getLogs windows; over-stating silently loses
        // logs, which is the failure a scan floor must never have.
        uint256 floorBlock = block.number;

        vm.startBroadcast(pk);
        MockXSGD xsgd = new MockXSGD();
        FixedRateSwap swap = new FixedRateSwap(IERC20(address(xsgd)));
        // EVERY payable token, not just the default one. An entry in `TOKENS` is
        // necessary and not sufficient — the swap must also LIST the token or `readRate`
        // throws `TokenUnsupported`, and since `accepts[]` fans out one priced offer per
        // payable token, ONE unlisted token 400s every 402 challenge including the vanilla
        // USDC one. EURC was originally listed by a one-off owner transaction, so the first
        // redeploy after it landed would have taken the whole machine door down while the
        // human door stayed green. Adding a payable token to `TOKENS` means adding it here.
        swap.setRate(REAL_USDC, DEMO_RATE);
        swap.setRate(REAL_EURC, DEMO_RATE_EURC);
        GantryCore core = new GantryCore(IERC20(address(xsgd)), deployer);
        core.setSwap(IGantrySwap(address(swap)));
        core.setFee(FEE_BPS, deployer);
        xsgd.mint(address(swap), SWAP_LIQUIDITY);
        // Last, and it takes the core it will pin: `CORE` is immutable in the factory and
        // in every wallet it mints, so this ordering is what makes the pair coherent by
        // construction rather than by an operator remembering to update an env var.
        AgentPBMWalletFactory factory = new AgentPBMWalletFactory(address(core));
        vm.stopBroadcast();

        console2.log("GantryCore:            ", address(core));
        console2.log("FixedRateSwap:         ", address(swap));
        console2.log("MockXSGD:              ", address(xsgd));
        console2.log("AgentPBMWalletFactory: ", address(factory));
        console2.log("Relayer/owner:         ", deployer);
        console2.log("Real USDC (listed):     0x036CbD53842c5426634e7929541eC2318f3dCF7e");
        console2.log("Real EURC (listed):     0x808456652fdb597867f38412077A9182bf77359F");
        console2.log("deploy block (floor):  ", floorBlock);
        console2.log("");
        console2.log("NEXT: pin all four + the deploy block in packages/shared/src/addresses.ts,");
        console2.log("      run pnpm abis, then pnpm demo:reset to re-register the demo shops.");
        console2.log("      The web bundle inlines addresses at BUILD time - redeploy Vercel.");
    }
}
