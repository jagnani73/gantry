// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP3009} from "./EIP3009.sol";

/// @title MockUSDC — test double for Circle's FiatToken (USDC) with hand-written EIP-3009
/// @notice Open mint = faucet-independent fallback for demos. Real Base Sepolia USDC
///         (0x036CbD53842c5426634e7929541eC2318f3dCF7e) is the primary pay token.
contract MockUSDC is EIP3009 {
    constructor() ERC20("Mock USDC", "USDC") {}

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
