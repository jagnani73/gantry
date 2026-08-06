// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEip712Domain} from "./Eip3009Digest.sol";

/// @notice Builds SpendAuthorization digests from the wallet's LIVE domain separator, so
///         the exact same code signs against unit-test and fork deployments alike
///         (sibling of Eip3009Digest).
library PbmDigest {
    bytes32 internal constant SPEND_AUTHORIZATION_TYPEHASH =
        keccak256("SpendAuthorization(bytes32 intentId,address token,uint256 amount)");

    function spendDigest(address wallet, bytes32 intentId, address token, uint256 amount)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(SPEND_AUTHORIZATION_TYPEHASH, intentId, token, amount));
        return keccak256(abi.encodePacked("\x19\x01", IEip712Domain(wallet).DOMAIN_SEPARATOR(), structHash));
    }
}
