// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {GantryCore} from "../src/GantryCore.sol";
import {AgentPBMWallet} from "../src/AgentPBMWallet.sol";
import {AgentPBMWalletFactory} from "../src/AgentPBMWalletFactory.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice M3 deploy: factory + the demo agent wallet against the EXISTING core (read
///         from env, never redeployed), armed with the canonical demo policy and funded
///         with MUSDC, plus the "gadgethub-sg" merchant for the rejection beat.
/// @dev Safely re-runnable: each run deploys a FRESH factory + wallet (the old one
///      strands with owner-reclaimable funds), and the one-shot registerMerchant is
///      guarded by a pre-broadcast existence probe. Rehearsal re-arms are NOT this
///      script — that's wallet.setPolicy through the relayer (demo-reset).
///
///      Run: forge script script/DeployPBM.s.sol --rpc-url base_sepolia --broadcast --verify
///      The wallet deploys inside factory.createWallet (broadcast `additionalContracts`);
///      if --verify misses it: forge verify-contract <wallet> src/AgentPBMWallet.sol:AgentPBMWallet \
///        --chain 84532 --constructor-args $(cast abi-encode "constructor(address,address,address)" \
///        <owner> <signer> <core>)
contract DeployPBM is Script {
    // "S$50/day" at the pinned 1.3421 rate: ceil(50e6 * 1e6 / 1_342_100) µUSDC. The cap
    // lives on-chain in token units — the UI converts back to S$ for display.
    uint128 internal constant DAILY_CAP_USDC = 37_255_049;
    uint128 internal constant PER_TX_CAP_USDC = 37_255_049; // = dailyCap; category is the demo's per-tx story
    uint256 internal constant CATEGORY_BITMAP = 1 << 1; // food_beverage only
    uint40 internal constant POLICY_TTL = 30 days;
    uint256 internal constant WALLET_FUNDING = 1_000e6; // MUSDC, open mint

    string internal constant GADGETHUB_HANDLE = "gadgethub-sg";
    uint16 internal constant CATEGORY_ELECTRONICS = 2;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        GantryCore core = GantryCore(vm.envAddress("GANTRY_CORE_ADDRESS"));
        MockUSDC usdc = MockUSDC(vm.envAddress("MOCK_USDC_ADDRESS"));
        // Required, no default: a defaulted signer would silently break apps/agent
        // signing — fail fast instead.
        address agentSigner = vm.envAddress("AGENT_SIGNER_ADDRESS");
        address gadgetPayout = vm.envOr("GADGETHUB_PAYOUT", deployer);

        if (gadgetPayout == deployer) {
            console2.log("WARNING: GADGETHUB_PAYOUT not set - payout defaults to deployer", deployer);
        }

        // registerMerchant is one-shot per handle; probe BEFORE broadcasting so re-runs
        // skip it cleanly instead of burning a reverting tx.
        (address existingPayout,,) = core.merchants(keccak256(bytes(GADGETHUB_HANDLE)));
        bool needGadget = existingPayout == address(0);
        if (!needGadget) {
            console2.log("gadgethub-sg already registered (payout %s) - skipping", existingPayout);
        }

        vm.startBroadcast(pk);
        AgentPBMWalletFactory factory = new AgentPBMWalletFactory(address(core));
        AgentPBMWallet wallet = AgentPBMWallet(factory.createWallet(agentSigner)); // owner = deployer = relayer key
        wallet.setPolicy(
            AgentPBMWallet.Policy({
                dailyCap: DAILY_CAP_USDC,
                perTxCap: PER_TX_CAP_USDC,
                // casting is safe: block.timestamp + 30 days fits uint40 until year ~36812
                // forge-lint: disable-next-line(unsafe-typecast)
                expiry: uint40(block.timestamp + POLICY_TTL),
                categoryBitmap: CATEGORY_BITMAP
            })
        );
        usdc.mint(address(wallet), WALLET_FUNDING);
        if (needGadget) {
            core.registerMerchant(GADGETHUB_HANDLE, gadgetPayout, CATEGORY_ELECTRONICS);
        }
        vm.stopBroadcast();

        console2.log("AgentPBMWalletFactory:", address(factory));
        console2.log("AgentPBMWallet (demo):", address(wallet));
        console2.log("  owner:             ", wallet.owner());
        console2.log("  agentSigner:       ", agentSigner);
        console2.log("  dailyCap (uUSDC):  ", DAILY_CAP_USDC);
        console2.log("  perTxCap (uUSDC):  ", PER_TX_CAP_USDC);
        console2.log("  categoryBitmap:    ", CATEGORY_BITMAP);
        console2.log("  funded (MUSDC):    ", WALLET_FUNDING);
        if (needGadget) {
            console2.log("gadgethub-sg registered, category", CATEGORY_ELECTRONICS);
            console2.log("merchantId:");
            console2.logBytes32(keccak256(bytes(GADGETHUB_HANDLE)));
        }
        console2.log("NEXT: pin factory+wallet in packages/shared/src/addresses.ts and run pnpm abis");
    }
}
