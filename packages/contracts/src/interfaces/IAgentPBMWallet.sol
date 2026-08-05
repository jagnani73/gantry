// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The agent door's policy wallet (purpose-bound money applied to AI agents).
///         The real wallet ships in M3 with Policy {dailyCap, perTxCap, expiry,
///         categoryBitmap} and custom errors PerTxCapExceeded, DailyCapExceeded,
///         CategoryNotAllowed(uint16), PolicyExpired — all enforced on-chain and
///         bubbled through GantryCore so the x402 facilitator can decode them.
interface IAgentPBMWallet {
    /// @notice Called by GantryCore during settlement. Must verify the agent session
    ///         key's EIP-712 signature binding at minimum (intentId, token, amount),
    ///         plus every policy dimension, then transfer `amount` of `token` to
    ///         msg.sender (the core). Reverts with a policy error otherwise.
    function authorizeSpend(bytes32 intentId, uint16 categoryId, address token, uint256 amount, bytes calldata agentSig)
        external;
}
