// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {GantryCore} from "../src/GantryCore.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice Proto-`demo-reset`: registers the canonical demo merchant and funds the demo
///         payer. Grows into the one-command reseed script in M1.
/// @dev One-shot per deployment: a second run reverts HandleTaken since the handle is
///      permanently claimed. Reseeding means redeploying (or using a fresh handle).
contract SeedDemo is Script {
    string internal constant HANDLE = "ah-hock-chicken-rice";
    uint16 internal constant CATEGORY_FOOD_BEVERAGE = 1;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        GantryCore core = GantryCore(vm.envAddress("GANTRY_CORE_ADDRESS"));
        MockUSDC usdc = MockUSDC(vm.envAddress("MOCK_USDC_ADDRESS"));
        address payout = vm.envOr("MERCHANT_PAYOUT", deployer);
        address payerToFund = vm.envOr("PAYER_ADDRESS", address(0));

        // Registration is irreversible for this handle — surface every defaulted env var
        // BEFORE broadcasting, not after.
        if (payout == deployer) {
            console2.log("WARNING: MERCHANT_PAYOUT not set - payout defaults to deployer", deployer);
        }
        if (payerToFund == address(0)) {
            console2.log("NOTE: PAYER_ADDRESS not set - no demo payer will be funded");
        }

        vm.startBroadcast(pk);
        bytes32 merchantId = core.registerMerchant(HANDLE, payout, CATEGORY_FOOD_BEVERAGE);
        if (payerToFund != address(0)) {
            usdc.mint(payerToFund, 1_000e6);
        }
        vm.stopBroadcast();

        console2.log("Merchant registered: %s", HANDLE);
        console2.log("merchantId:");
        console2.logBytes32(merchantId);
        console2.log("payout:        ", payout);
        if (payerToFund != address(0)) {
            console2.log("payer funded:  ", payerToFund);
        }
    }
}
