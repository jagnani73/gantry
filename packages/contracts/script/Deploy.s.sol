// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GantryCore} from "../src/GantryCore.sol";
import {FixedRateSwap} from "../src/FixedRateSwap.sol";
import {IGantrySwap} from "../src/interfaces/IGantrySwap.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockXSGD} from "../src/mocks/MockXSGD.sol";

/// @notice v0 deployment: mocks + fixed-rate swap seeded to the demo rate + core with
///         the deployer as relayer/owner. Real Circle USDC stays the primary pay token;
///         MockUSDC is the faucet-independent fallback.
contract Deploy is Script {
    address internal constant REAL_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    uint256 internal constant DEMO_RATE = 1_342_100; // 1.3421 XSGD per USDC, 6dp
    uint256 internal constant SWAP_LIQUIDITY = 1_000_000e6; // 1M XSGD
    uint16 internal constant FEE_BPS = 50; // 0.5% — the fee story shown in the demo

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);
        MockUSDC usdc = new MockUSDC();
        MockXSGD xsgd = new MockXSGD();
        FixedRateSwap swap = new FixedRateSwap(IERC20(address(xsgd)));
        swap.setRate(address(usdc), DEMO_RATE);
        swap.setRate(REAL_USDC, DEMO_RATE); // primary pay token
        GantryCore core = new GantryCore(IERC20(address(xsgd)), deployer);
        core.setSwap(IGantrySwap(address(swap)));
        core.setFee(FEE_BPS, deployer);
        xsgd.mint(address(swap), SWAP_LIQUIDITY);
        vm.stopBroadcast();

        console2.log("GantryCore:    ", address(core));
        console2.log("FixedRateSwap: ", address(swap));
        console2.log("MockUSDC:      ", address(usdc));
        console2.log("MockXSGD:      ", address(xsgd));
        console2.log("Relayer/owner: ", deployer);
        console2.log("Real USDC:      0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    }
}
