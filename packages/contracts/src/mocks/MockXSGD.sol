// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP3009} from "./EIP3009.sol";

/// @title MockXSGD — honest stand-in for StraitsX XSGD, which exists on no testnet
/// @notice 6 decimals matching mainnet XSGD. Carries EIP-3009 because real XSGD supports
///         x402 natively (StraitsX), so XSGD-direct payments flow through the same
///         authorization door. Open mint for demo seeding.
contract MockXSGD is EIP3009 {
    constructor() ERC20("Mock XSGD", "XSGD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function version() public pure override returns (string memory) {
        return "1";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
