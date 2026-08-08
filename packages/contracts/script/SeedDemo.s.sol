// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {GantryCore} from "../src/GantryCore.sol";

/// @notice Proto-`demo-reset`: registers the canonical demo merchant. Superseded by
///         `pnpm demo:reset` (scripts/demo-reset.mjs) for everything else.
/// @dev One-shot per deployment: a second run reverts HandleTaken since the handle is
///      permanently claimed. Reseeding means redeploying (or using a fresh handle).
///
///      It used to also mint the demo payer 1,000 MockUSDC. Payers hold real Circle
///      USDC now, which cannot be minted — the relayer funds them by transfer, either
///      through the payer page's faucet call or `POST /api/admin/wallet/topup`.
contract SeedDemo is Script {
    string internal constant HANDLE = "ah-hock-chicken-rice";
    uint16 internal constant CATEGORY_FOOD_BEVERAGE = 1;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        GantryCore core = GantryCore(vm.envAddress("GANTRY_CORE_ADDRESS"));
        address payout = vm.envOr("MERCHANT_PAYOUT", deployer);

        // Registration is irreversible for this handle — surface every defaulted env var
        // BEFORE broadcasting, not after.
        if (payout == deployer) {
            console2.log("WARNING: MERCHANT_PAYOUT not set - payout defaults to deployer", deployer);
        }

        vm.startBroadcast(pk);
        bytes32 merchantId = core.registerMerchant(HANDLE, payout, CATEGORY_FOOD_BEVERAGE);
        vm.stopBroadcast();

        console2.log("Merchant registered: %s", HANDLE);
        console2.log("merchantId:");
        console2.logBytes32(merchantId);
        console2.log("payout:        ", payout);
    }
}
