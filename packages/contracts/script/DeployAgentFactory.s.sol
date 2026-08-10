// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {GantryCore} from "../src/GantryCore.sol";
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

        // Proven to BE the core before anything is broadcast. `CORE` is immutable in the
        // factory and in every wallet it mints, so a stale or typo'd address is
        // unrecoverable — the factory deploys happily (it only rejects address(0)) and
        // the mistake surfaces at the first agent payment, as `NotCore`, after payers
        // have created, funded and armed wallets against it. This read fails against an
        // EOA and against any contract that is not a GantryCore, and costs one RPC call.
        // DeployPBM got this for free from its `core.merchants(...)` probe; splitting
        // that script is what dropped it, so it is explicit here.
        console2.log("core feeBps:", GantryCore(core).feeBps());

        vm.startBroadcast(pk);
        AgentPBMWalletFactory factory = new AgentPBMWalletFactory(core);
        vm.stopBroadcast();

        console2.log("AgentPBMWalletFactory:", address(factory));
        console2.log("  core:               ", core);
        // The scan floor, and the value a redeploy is most likely to forget — an
        // unchanged deploy block sends every cold scan back over blocks that cannot hold
        // one of this factory's logs.
        //
        // A safe FLOOR, not the receipt: forge runs a script one block past the fork
        // head and the broadcast then mines at that block or later, so this can only
        // under-state. That is the harmless direction (a few extra getLogs windows);
        // over-stating would silently lose wallets. `broadcast/DeployAgentFactory.s.sol/
        // 84532/run-latest.json` carries the authoritative receipt block — pin that.
        console2.log("  deploy block (floor):", block.number);
        console2.log("NEXT: pin agentPbmFactory + BASE_SEPOLIA_FACTORY_DEPLOY_BLOCK in");
        console2.log("      packages/shared/src/addresses.ts, then run pnpm demo:reset");
    }
}
