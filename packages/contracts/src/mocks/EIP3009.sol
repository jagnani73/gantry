// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title EIP3009 — hand-written EIP-3009 authorization layer for the mock tokens
/// @notice Mirrors the FiatTokenV2_2 authorization surface (typehash strings, events,
///         authorizationState) so one signing path serves mocks and real USDC alike.
///         Clients may derive the domain from name()/version() or read
///         DOMAIN_SEPARATOR() directly (what the test digest helper does).
///         Known divergence from real FiatTokenV2_2: no EIP-1271 contract-signature
///         support — smart-account payers work only against the real token.
abstract contract EIP3009 is ERC20 {
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    // Typehash strings must match FiatTokenV2 byte-for-byte, or the canonical EIP-3009
    // typed data that wallets sign would produce digests this contract rejects.
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed(address authorizer, bytes32 nonce);
    error InvalidSignature();
    error CallerMustBePayee();
    error InvalidSignatureLength();

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    function version() public pure virtual returns (string memory);

    /// @dev Computed per call with block.chainid so signatures stay valid on forks/anvil.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(name())),
                keccak256(bytes(version())),
                block.chainid,
                address(this)
            )
        );
    }

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

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
    ) external {
        _transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s);
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        (uint8 v, bytes32 r, bytes32 s) = _splitSignature(signature);
        _transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (to != msg.sender) revert CallerMustBePayee();
        _checkAuthorization(from, nonce, validAfter, validBefore);
        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        _verifySignature(from, structHash, v, r, s);
        _markAuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationAlreadyUsed(authorizer, nonce);
        bytes32 structHash = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce));
        _verifySignature(authorizer, structHash, v, r, s);
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        _checkAuthorization(from, nonce, validAfter, validBefore);
        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        _verifySignature(from, structHash, v, r, s);
        _markAuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    function _checkAuthorization(address authorizer, bytes32 nonce, uint256 validAfter, uint256 validBefore)
        internal
        view
    {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationAlreadyUsed(authorizer, nonce);
    }

    function _verifySignature(address signer, bytes32 structHash, uint8 v, bytes32 r, bytes32 s) internal view {
        // Reject malleable high-s signatures and bad v, matching Circle's ECRecover —
        // keeps mock and real USDC accepting the same signature set.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert InvalidSignature();
        }
        if (v != 27 && v != 28) revert InvalidSignature();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0) || recovered != signer) revert InvalidSignature();
    }

    function _markAuthorizationUsed(address authorizer, bytes32 nonce) internal {
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationUsed(authorizer, nonce);
    }

    function _splitSignature(bytes memory signature) internal pure returns (uint8 v, bytes32 r, bytes32 s) {
        if (signature.length != 65) revert InvalidSignatureLength();
        assembly ("memory-safe") {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
    }
}
