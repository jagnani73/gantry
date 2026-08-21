// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Erc1271Owner
 * @notice A contract account that validates one owner's ECDSA signature under
 *         EIP-1271. A TEST DOUBLE, and deliberately the smallest one that can
 *         stand in for the real thing.
 *
 * @dev Exists for one reason: `assertOwnsShop` has a second verification tier
 *      for payouts that are CONTRACT accounts, because `/onboard`'s passkey
 *      button mints a Base Smart Account whose signature cannot be recovered.
 *      Nothing in this repo could exercise that tier — every payout in the demo
 *      is an EOA, and a real Base Account needs a device with biometrics — so
 *      the branch shipped unexercised. This makes it testable.
 *
 *      What it stands in for is the DEPLOYED half. A real passkey account is
 *      also COUNTERFACTUAL until its first outgoing transaction, and that half
 *      travels a different road (an ERC-6492 wrapper the wallet supplies, which
 *      viem cannot construct without `factory`/`factoryData`). This contract
 *      cannot prove that half, and no test here should claim it does.
 *
 *      No deploy script ships this and no `addresses.ts` entry names it, the
 *      same footing as `MockStablecoin`.
 */
contract Erc1271Owner {
    /// @dev `bytes4(keccak256("isValidSignature(bytes32,bytes)"))`.
    bytes4 private constant MAGIC = 0x1626ba7e;
    bytes4 private constant INVALID = 0xffffffff;

    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 65) return INVALID;

        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);

        // `ecrecover` returns the zero address on failure rather than reverting,
        // so the owner check alone is not enough: a zero owner would accept
        // every malformed signature.
        address recovered = ecrecover(hash, v, r, s);
        if (recovered == address(0)) return INVALID;
        return recovered == owner ? MAGIC : INVALID;
    }
}
