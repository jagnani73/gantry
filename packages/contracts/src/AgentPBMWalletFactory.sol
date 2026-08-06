// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentPBMWallet} from "./AgentPBMWallet.sol";

/// @title AgentPBMWalletFactory — permissionless AgentPBMWallet onboarding
/// @notice Anyone can deploy a policy wallet for their agent in one tx: the caller
///         becomes the owner, supplies the agent's session-key address, and funds +
///         policy follow as ordinary owner calls on the new wallet.
contract AgentPBMWalletFactory {
    address public immutable CORE;

    mapping(address => address[]) private _walletsOf;

    error ZeroAddress();

    event WalletCreated(address indexed owner, address indexed agentSigner, address wallet);

    constructor(address core_) {
        if (core_ == address(0)) revert ZeroAddress();
        CORE = core_;
    }

    /// @notice Deploys a wallet owned by the caller. The agentSigner zero-check lives in
    ///         the wallet constructor and bubbles up as the same ZeroAddress selector.
    function createWallet(address agentSigner) external returns (address wallet) {
        wallet = address(new AgentPBMWallet(msg.sender, agentSigner, CORE));
        _walletsOf[msg.sender].push(wallet);
        emit WalletCreated(msg.sender, agentSigner, wallet);
    }

    /// @notice All wallets ever created by `owner` through this factory (discovery for
    ///         backends that don't index WalletCreated).
    function walletsOf(address owner) external view returns (address[] memory) {
        return _walletsOf[owner];
    }
}
