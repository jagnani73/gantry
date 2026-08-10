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
    /// @param label The owner's display name for the wallet; may be empty. Taken here so
    ///        naming an agent costs no transaction of its own — creating and arming one
    ///        stays two, and the label rides in the first.
    /// @dev   Deliberately NOT added to WalletCreated. A label is mutable, so a creation
    ///        log would be a record of what it was called once; enumeration reads the
    ///        live `label()` for the same reason it reads live `owner()`/`agentSigner()`.
    function createWallet(address agentSigner, string calldata label) external returns (address wallet) {
        wallet = address(new AgentPBMWallet(msg.sender, agentSigner, CORE, label));
        _walletsOf[msg.sender].push(wallet);
        emit WalletCreated(msg.sender, agentSigner, wallet);
    }

    /// @notice All wallets ever created by `owner` through this factory (discovery for
    ///         backends that don't index WalletCreated).
    function walletsOf(address owner) external view returns (address[] memory) {
        return _walletsOf[owner];
    }
}
