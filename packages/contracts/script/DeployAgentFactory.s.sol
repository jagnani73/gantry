// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {AgentPBMWalletFactory} from "../src/AgentPBMWalletFactory.sol";

/// @notice Deploys ONLY the AgentPBMWalletFactory against the existing core.
/// @dev    Split out from DeployPBM deliberately. That script also creates a
///         relayer-owned wallet and arms it — the historical path from before agent
///         wallets became payer-owned — so re-running it to get a new factory mints a
///         wallet nothing should use and burns two more transactions. Provisioning a
///         usable wallet is `pnpm demo:reset`, which creates one through the factory
///         with the PAYER's key.
///
///         Deploying a new factory ORPHANS every wallet the previous one created: the
///         backend enumerates agents from `WalletCreated` logs, so wallets from an older
///         factory still work and still hold funds, but no screen lists them. That is
///         accepted whenever the wallet's own ABI changes — a factory can only mint the
///         implementation it was compiled against.
///
///         Run: forge script script/DeployAgentFactory.s.sol --rpc-url base_sepolia \
///                --broadcast --verify
///         Then pin BOTH values it prints in packages/shared/src/addresses.ts:
///         the address AND the deploy block, which is where every factory scan starts.
contract DeployAgentFactory is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address core = vm.envAddress("GANTRY_CORE_ADDRESS");

        vm.startBroadcast(pk);
        AgentPBMWalletFactory factory = new AgentPBMWalletFactory(core);
        vm.stopBroadcast();

        console2.log("AgentPBMWalletFactory:", address(factory));
        console2.log("  core:               ", core);
        // The scan floor. Reading it from the receipt afterwards is the same number, but
        // it is the one value a redeploy is most likely to forget — an unchanged deploy
        // block sends every cold scan back over ~68k blocks that cannot hold a log.
        console2.log("  deploy block:       ", block.number);
        console2.log("NEXT: pin agentPbmFactory + BASE_SEPOLIA_FACTORY_DEPLOY_BLOCK in");
        console2.log("      packages/shared/src/addresses.ts, then run pnpm demo:reset");
    }
}
