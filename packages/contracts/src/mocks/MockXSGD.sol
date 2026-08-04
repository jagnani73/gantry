// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockXSGD — honest stand-in for StraitsX XSGD, which exists on no testnet
/// @notice 6 decimals matching mainnet XSGD. Open mint for demo seeding.
contract MockXSGD is ERC20 {
    constructor() ERC20("Mock XSGD", "XSGD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
