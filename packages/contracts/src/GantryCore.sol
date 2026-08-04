// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title GantryCore — payer-agnostic settlement rail
/// @notice One merchant registry, one PaymentIntent lifecycle, two settlement doors
///         (EIP-3009 authorization for QR humans + x402 `exact`, PBM wallet for agents).
///         All doors converge on a single settlement path paying merchants in XSGD.
contract GantryCore is Ownable {
    // ---------------------------------------------------------------- types

    struct Merchant {
        address payout;
        uint16 categoryId;
        string handle;
    }

    // ---------------------------------------------------------------- storage

    IERC20 public immutable XSGD;
    address public relayer;

    mapping(bytes32 => Merchant) public merchants;

    // ---------------------------------------------------------------- errors

    error InvalidHandle();
    error HandleTaken(bytes32 merchantId);
    error InvalidCategory(uint16 categoryId);
    error ZeroAddress();

    // ---------------------------------------------------------------- events

    event MerchantRegistered(bytes32 indexed merchantId, string handle, address payout, uint16 categoryId);
    event RelayerUpdated(address relayer);

    // ---------------------------------------------------------------- setup

    constructor(IERC20 xsgd_, address relayer_) Ownable(msg.sender) {
        if (address(xsgd_) == address(0) || relayer_ == address(0)) revert ZeroAddress();
        XSGD = xsgd_;
        relayer = relayer_;
    }

    // ---------------------------------------------------------------- registry

    /// @notice Permissionless single-tx onboarding: a merchant is live once this mines.
    /// @dev Categories are capped at 256 so a future PBM policy can hold the whole
    ///      allowlist as one uint256 bitmap (bit = categoryId).
    function registerMerchant(string calldata handle, address payout, uint16 categoryId)
        external
        returns (bytes32 merchantId)
    {
        if (payout == address(0)) revert ZeroAddress();
        if (categoryId >= 256) revert InvalidCategory(categoryId);
        _validateHandle(handle);

        merchantId = keccak256(bytes(handle));
        if (merchants[merchantId].payout != address(0)) revert HandleTaken(merchantId);

        merchants[merchantId] = Merchant({payout: payout, categoryId: categoryId, handle: handle});
        emit MerchantRegistered(merchantId, handle, payout, categoryId);
    }

    /// @notice merchantId is derived from the URL handle, so clients never need a lookup.
    function merchantIdOf(string calldata handle) external pure returns (bytes32) {
        return keccak256(bytes(handle));
    }

    // ---------------------------------------------------------------- admin

    function setRelayer(address relayer_) external onlyOwner {
        if (relayer_ == address(0)) revert ZeroAddress();
        relayer = relayer_;
        emit RelayerUpdated(relayer_);
    }

    // ---------------------------------------------------------------- internal

    /// @dev Handles are URL path segments (`/pay/<handle>`): 1-32 bytes of [a-z0-9-],
    ///      no leading/trailing hyphen.
    function _validateHandle(string calldata handle) internal pure {
        bytes calldata b = bytes(handle);
        uint256 len = b.length;
        if (len == 0 || len > 32) revert InvalidHandle();
        if (b[0] == "-" || b[len - 1] == "-") revert InvalidHandle();
        for (uint256 i; i < len; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-";
            if (!ok) revert InvalidHandle();
        }
    }
}
