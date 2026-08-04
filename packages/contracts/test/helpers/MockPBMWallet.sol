// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAgentPBMWallet} from "../../src/interfaces/IAgentPBMWallet.sol";

/// @notice Trivial stand-in for M3's AgentPBMWallet: pays, stays silent, or reverts with
///         the same CategoryNotAllowed error the real wallet will use — proving today
///         that policy denials bubble out of GantryCore as decodable reverts.
contract MockPBMWallet is IAgentPBMWallet {
    enum Mode {
        Pay,
        Silent,
        RevertCategory
    }

    Mode public mode;

    // Mirrors the M3 AgentPBMWallet error so the revert-bubbling test is representative.
    error CategoryNotAllowed(uint16 categoryId);

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function authorizeSpend(bytes32, uint16 categoryId, address token, uint256 amount, bytes calldata) external {
        if (mode == Mode.RevertCategory) revert CategoryNotAllowed(categoryId);
        if (mode == Mode.Silent) return;
        IERC20(token).transfer(msg.sender, amount);
    }
}
