// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {GantryCore} from "../src/GantryCore.sol";
import {AgentPBMWallet} from "../src/AgentPBMWallet.sol";
import {AgentPBMWalletFactory} from "../src/AgentPBMWalletFactory.sol";

/// @notice M3 deploy: factory + the demo agent wallet against the EXISTING core (read
///         from env, never redeployed), armed with the canonical demo policy, plus the
///         "gadgethub-sg" merchant for the rejection beat.
/// @dev    The wallet ships EMPTY. It used to be minted 1,000 MockUSDC here, but every
///         door settles in real Circle USDC now and real USDC cannot be minted — funding
///         is a relayer transfer through `POST /api/admin/wallet/topup`, which `demo:reset`
///         calls. Minting the mock would leave the wallet holding a token nothing reads,
///         and the rejection beat would then die as `insufficient_funds` at the
///         facilitator's balance pre-check instead of reaching `CategoryNotAllowed`.
/// @dev DO NOT re-run this against the live deployment. It was described here as
///      "safely re-runnable" on the grounds that each run deploys a fresh factory and
///      wallet; that is what it does, and it is exactly the danger. Only
///      registerMerchant is guarded by an existence probe. The factory deployment,
///      createWallet and setPolicy all run unconditionally, so a re-run mints a NEW
///      factory that `addresses.ts` does not point at — orphaning every wallet payers
///      have created through the old one, since agent wallets are enumerated from that
///      factory's WalletCreated logs.
///
///      This script is also the HISTORICAL path: it creates a RELAYER-owned wallet, and
///      agent wallets are payer-owned now. Provisioning a usable wallet is
///      `pnpm demo:reset`, which creates one through the already-deployed factory and
///      arms it with the PAYER's key (setPolicy is onlyOwner, and no server key can
///      call it any more).
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

    string internal constant GADGETHUB_HANDLE = "gadgethub-sg";
    uint16 internal constant CATEGORY_ELECTRONICS = 2;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        GantryCore core = GantryCore(vm.envAddress("GANTRY_CORE_ADDRESS"));
        // Required, no default: a defaulted signer would silently break packages/agent
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
        AgentPBMWallet wallet = AgentPBMWallet(factory.createWallet(agentSigner, "")); // owner = deployer = relayer key
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
        console2.log("  balance:            0 - fund it with real USDC, see NEXT below");
        if (needGadget) {
            console2.log("gadgethub-sg registered, category", CATEGORY_ELECTRONICS);
            console2.log("merchantId:");
            console2.logBytes32(keccak256(bytes(GADGETHUB_HANDLE)));
        }
        console2.log("NEXT: pin factory+wallet in packages/shared/src/addresses.ts, run pnpm abis,");
        console2.log("      then fund the wallet: pnpm demo:reset (POST /api/admin/wallet/topup)");
    }
}
