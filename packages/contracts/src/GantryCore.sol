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

    enum IntentStatus {
        None,
        Pending,
        Settled,
        Cancelled
    }

    enum Door {
        Human,
        Agent
    }

    /// @dev Economic terms are pinned at creation; the payer's signature then binds to
    ///      exactly these numbers. A requote is cancel + recreate, never mutation.
    struct PaymentIntent {
        bytes32 merchantId;
        address tokenIn;
        uint40 expiry;
        IntentStatus status;
        Door door;
        uint128 xsgdAmount; // merchant price, XSGD 6dp (S$6.50 = 6_500_000)
        uint128 amountIn; // quoted payer amount, tokenIn decimals
    }

    // ---------------------------------------------------------------- storage

    IERC20 public immutable XSGD;
    address public relayer;
    uint256 private _intentNonce;

    mapping(bytes32 => Merchant) public merchants;
    mapping(bytes32 => PaymentIntent) public intents;

    // ---------------------------------------------------------------- errors

    error InvalidHandle();
    error HandleTaken(bytes32 merchantId);
    error InvalidCategory(uint16 categoryId);
    error ZeroAddress();
    error NotRelayer();
    error MerchantNotFound(bytes32 merchantId);
    error ZeroAmount();
    error BadExpiry(uint40 expiry);
    error XsgdAmountMismatch(uint256 amountIn, uint256 xsgdAmount);
    error UnknownIntent(bytes32 intentId);
    error IntentAlreadySettled(bytes32 intentId);
    error IntentWasCancelled(bytes32 intentId);

    // ---------------------------------------------------------------- events

    event MerchantRegistered(bytes32 indexed merchantId, string handle, address payout, uint16 categoryId);
    event IntentCreated(
        bytes32 indexed intentId,
        bytes32 indexed merchantId,
        address tokenIn,
        uint256 amountIn,
        uint256 xsgdAmount,
        uint40 expiry,
        Door door
    );
    event IntentCancelled(bytes32 indexed intentId);
    event RelayerUpdated(address relayer);

    // ---------------------------------------------------------------- modifiers

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert NotRelayer();
        _;
    }

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

    // ---------------------------------------------------------------- intents

    /// @notice Relayer-only: the backend quotes tokenIn/amountIn off-chain when a payer
    ///         opens the pay page (or a 402 is issued) and pins the terms on-chain here.
    /// @dev intentId doubles as the EIP-3009 nonce, so it is chain- and contract-bound
    ///      to make authorizations unreplayable across deployments.
    function createIntent(
        bytes32 merchantId,
        uint128 xsgdAmount,
        address tokenIn,
        uint128 amountIn,
        uint40 expiry,
        Door door
    ) external onlyRelayer returns (bytes32 intentId) {
        if (merchants[merchantId].payout == address(0)) revert MerchantNotFound(merchantId);
        if (tokenIn == address(0)) revert ZeroAddress();
        if (xsgdAmount == 0 || amountIn == 0) revert ZeroAmount();
        if (expiry <= block.timestamp) revert BadExpiry(expiry);
        // An XSGD-denominated payment needs no swap, so the amounts must agree.
        if (tokenIn == address(XSGD) && amountIn != xsgdAmount) {
            revert XsgdAmountMismatch(amountIn, xsgdAmount);
        }

        intentId = keccak256(abi.encode(block.chainid, address(this), merchantId, _intentNonce++));
        intents[intentId] = PaymentIntent({
            merchantId: merchantId,
            tokenIn: tokenIn,
            expiry: expiry,
            status: IntentStatus.Pending,
            door: door,
            xsgdAmount: xsgdAmount,
            amountIn: amountIn
        });
        emit IntentCreated(intentId, merchantId, tokenIn, amountIn, xsgdAmount, expiry, door);
    }

    /// @notice Cancellation stays possible after expiry so the relayer can clean up.
    function cancelIntent(bytes32 intentId) external onlyRelayer {
        PaymentIntent storage intent = intents[intentId];
        if (intent.status == IntentStatus.None) revert UnknownIntent(intentId);
        if (intent.status == IntentStatus.Settled) revert IntentAlreadySettled(intentId);
        if (intent.status == IntentStatus.Cancelled) revert IntentWasCancelled(intentId);
        intent.status = IntentStatus.Cancelled;
        emit IntentCancelled(intentId);
    }

    function getIntent(bytes32 intentId) external view returns (PaymentIntent memory) {
        return intents[intentId];
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
