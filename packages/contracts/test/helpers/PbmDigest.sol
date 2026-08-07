// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEip712Domain} from "./Eip3009Digest.sol";

interface IPbmTypehash {
    function SPEND_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
}

/// @notice Builds SpendAuthorization digests from the wallet's LIVE domain separator AND
///         LIVE typehash, so every test signature — including the cross-stack vector —
///         pins the deployed contract's actual EIP-712 encoding, not a mirrored constant
///         that could drift with it (sibling of Eip3009Digest).
library PbmDigest {
    function spendDigest(address wallet, bytes32 intentId, address token, uint256 amount)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(IPbmTypehash(wallet).SPEND_AUTHORIZATION_TYPEHASH(), intentId, token, amount));
        return keccak256(abi.encodePacked("\x19\x01", IEip712Domain(wallet).DOMAIN_SEPARATOR(), structHash));
    }
}
