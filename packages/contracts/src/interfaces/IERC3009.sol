// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal EIP-3009 surface GantryCore needs; matches Circle FiatTokenV2+.
interface IERC3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);

    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
