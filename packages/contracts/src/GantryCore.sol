// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAgentPBMWallet} from "./interfaces/IAgentPBMWallet.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {IGantrySwap} from "./interfaces/IGantrySwap.sol";

/// @title GantryCore — payer-agnostic settlement rail
/// @notice One merchant registry, one PaymentIntent lifecycle, two settlement doors
///         (EIP-3009 authorization for QR humans + x402 `exact`, PBM wallet for agents).
///         All doors converge on a single settlement path paying merchants in XSGD.
contract GantryCore is Ownable2Step {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- types

    /// @dev Merchants are never deleted (only the payout rotates), so a non-zero payout
    ///      is a permanent existence proof — _settle relies on this when it pays out.
    struct Merchant {
        address payout;
        uint16 categoryId;
        string handle;
    }

    /// @dev None MUST stay the first member (zero value = "intent does not exist");
    ///      new statuses are append-only — the raw uint8 is ABI/indexer-visible.
    enum IntentStatus {
        None,
        Pending,
        Settled,
        Cancelled
    }

    /// @dev Attribution label chosen by the relayer at quote time; Human MUST stay the
    ///      zero value. Agent intents may settle through the authorization door (that IS
    ///      the x402 `exact` path), but settleFromPBM accepts only Agent intents, so the
    ///      dashboard's Human/Agent badge can never show a human paying via PBM wallet.
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

    uint16 public constant MAX_FEE_BPS = 200; // 2% governance ceiling

    IERC20 public immutable XSGD;
    address public relayer;
    IGantrySwap public swap;
    uint16 public feeBps; // protocol fee in basis points, skimmed from settled XSGD
    address public feeRecipient;
    uint256 private _intentNonce;
    uint256 private _lock = 1;

    mapping(bytes32 => Merchant) public merchants;
    mapping(bytes32 => PaymentIntent) private _intents;

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
    error IntentExpired(bytes32 intentId, uint40 expiry);
    error PBMPullFailed(uint256 received, uint256 expected);
    error SwapNotSet();
    error InsufficientXsgdOut(uint256 got, uint256 min);
    error Reentrancy();
    error NotAgentIntent(bytes32 intentId);
    error NotMerchantPayout(bytes32 merchantId);
    error FeeTooHigh(uint16 feeBps);
    error OwnershipCannotBeRenounced();

    // ---------------------------------------------------------------- events

    event MerchantRegistered(bytes32 indexed merchantId, string handle, address payout, uint16 categoryId);
    event MerchantPayoutUpdated(bytes32 indexed merchantId, address payout);
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
    /// @dev xsgdOut is the gross conversion; the merchant receives xsgdOut - feeXsgd.
    event IntentSettled(
        bytes32 indexed intentId,
        bytes32 indexed merchantId,
        address indexed payer,
        address tokenIn,
        uint256 amountIn,
        uint256 xsgdOut,
        uint256 feeXsgd,
        Door door
    );
    event RelayerUpdated(address relayer);
    event SwapUpdated(address swap);
    event FeeUpdated(uint16 feeBps, address feeRecipient);
    event Rescued(address token, address to, uint256 amount);

    // ---------------------------------------------------------------- modifiers

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert NotRelayer();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
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

    /// @notice Rotates where a merchant gets paid. Only the current payout address may
    ///         call — the printed QR encodes the handle, so a compromised or fat-fingered
    ///         payout must be fixable without reprinting.
    function setMerchantPayout(bytes32 merchantId, address newPayout) external {
        if (newPayout == address(0)) revert ZeroAddress();
        Merchant storage merchant = merchants[merchantId];
        if (merchant.payout == address(0)) revert MerchantNotFound(merchantId);
        if (msg.sender != merchant.payout) revert NotMerchantPayout(merchantId);
        merchant.payout = newPayout;
        emit MerchantPayoutUpdated(merchantId, newPayout);
    }

    // ---------------------------------------------------------------- intents

    /// @notice Relayer-only: the backend quotes tokenIn/amountIn off-chain when a payer
    ///         opens the pay page (or a 402 is issued) and pins the terms on-chain here.
    /// @dev intentId doubles as the EIP-3009 nonce, so it is chain- and contract-bound
    ///      to make authorizations unreplayable across deployments. The settlement path
    ///      assumes tokenIn transfers exactly the requested amount — the relayer must
    ///      only quote vetted, no-fee-on-transfer tokens (USDC/XSGD).
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
        _intents[intentId] = PaymentIntent({
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
        PaymentIntent storage intent = _requirePending(intentId);
        intent.status = IntentStatus.Cancelled;
        emit IntentCancelled(intentId);
    }

    /// @notice Returns the zero struct (status None) for unknown ids — callers must
    ///         check `status != None` rather than expect a revert.
    function getIntent(bytes32 intentId) external view returns (PaymentIntent memory) {
        return _intents[intentId];
    }

    // ---------------------------------------------------------------- settlement: EIP-3009 door

    /// @notice Settles an intent with the payer's gasless EIP-3009 authorization. Serves
    ///         both the QR (human) door and the x402 `exact` (agent) door. Permissionless:
    ///         the signature alone binds payer, amount, recipient AND intent, because the
    ///         token-level nonce passed below is hardcoded to the intentId.
    /// @dev Known griefing vector, accepted by design (transferWithAuthorization is what
    ///      vanilla x402 clients sign): an observer can replay the raw signature directly
    ///      against the token, landing funds here without settling. Settlement then reverts
    ///      inside the token (authorization used); funds are recoverable via rescueERC20.
    function settleWithAuthorization(
        bytes32 intentId,
        address payer,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        PaymentIntent storage intent = _beginSettle(intentId);
        IERC3009(intent.tokenIn).transferWithAuthorization(
            payer, address(this), intent.amountIn, validAfter, validBefore, intentId, v, r, s
        );
        _settle(intentId, intent, payer);
    }

    // ---------------------------------------------------------------- settlement: PBM door

    /// @notice Settles an intent from an agent's policy wallet (x402 `gantry-pbm` scheme).
    ///         The wallet verifies the agent session key's signature and every policy
    ///         dimension on-chain; its policy errors (e.g. CategoryNotAllowed) bubble up
    ///         through this call — that is how a denial reaches the x402 facilitator as a
    ///         decodable revert instead of a backend if-statement.
    function settleFromPBM(bytes32 intentId, address pbmWallet, bytes calldata agentSig) external nonReentrant {
        PaymentIntent storage intent = _beginSettle(intentId);
        // The dashboard's Human/Agent badge rides on intent.door; a Human-door intent
        // settling from a policy wallet would falsify it.
        if (intent.door != Door.Agent) revert NotAgentIntent(intentId);

        uint256 balanceBefore = IERC20(intent.tokenIn).balanceOf(address(this));
        IAgentPBMWallet(pbmWallet).authorizeSpend(
            intentId, merchants[intent.merchantId].categoryId, intent.tokenIn, intent.amountIn, agentSig
        );
        uint256 received = IERC20(intent.tokenIn).balanceOf(address(this)) - balanceBefore;
        if (received < intent.amountIn) revert PBMPullFailed(received, intent.amountIn);

        _settle(intentId, intent, pbmWallet);
    }

    // ---------------------------------------------------------------- admin

    function setRelayer(address relayer_) external onlyOwner {
        if (relayer_ == address(0)) revert ZeroAddress();
        relayer = relayer_;
        emit RelayerUpdated(relayer_);
    }

    function setSwap(IGantrySwap swap_) external onlyOwner {
        swap = swap_;
        emit SwapUpdated(address(swap_));
    }

    /// @notice Protocol fee skimmed from settled XSGD, capped at MAX_FEE_BPS. A non-zero
    ///         fee requires a recipient; feeBps 0 disables skimming entirely.
    function setFee(uint16 feeBps_, address feeRecipient_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_);
        if (feeBps_ > 0 && feeRecipient_ == address(0)) revert ZeroAddress();
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
        emit FeeUpdated(feeBps_, feeRecipient_);
    }

    /// @notice Recovers tokens stranded by authorization front-running (see
    ///         settleWithAuthorization) so the owner can refund the payer.
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    /// @dev The owner key is the only route to rescueERC20 refunds and relayer rotation;
    ///      renouncing it would permanently brick both, so it is disabled. Transfers are
    ///      two-step (Ownable2Step) so a typoed address cannot take ownership silently.
    function renounceOwnership() public pure override {
        revert OwnershipCannotBeRenounced();
    }

    // ---------------------------------------------------------------- internal

    /// @dev Shared Pending gate for cancel and settle paths — a status added later must
    ///      be handled here once, not in two drifting copies.
    function _requirePending(bytes32 intentId) internal view returns (PaymentIntent storage intent) {
        intent = _intents[intentId];
        if (intent.status == IntentStatus.None) revert UnknownIntent(intentId);
        if (intent.status == IntentStatus.Settled) revert IntentAlreadySettled(intentId);
        if (intent.status == IntentStatus.Cancelled) revert IntentWasCancelled(intentId);
    }

    /// @dev Validates the intent is settleable and flips it to Settled BEFORE any external
    ///      call (checks-effects-interactions) — this, plus nonReentrant, is the
    ///      double-settle guard. Also fails fast on a missing swap so no funds are pulled
    ///      that the settlement path can't convert. Settling at the exact expiry second
    ///      is allowed (strict > comparison).
    function _beginSettle(bytes32 intentId) internal returns (PaymentIntent storage intent) {
        intent = _requirePending(intentId);
        if (block.timestamp > intent.expiry) revert IntentExpired(intentId, intent.expiry);
        if (intent.tokenIn != address(XSGD) && address(swap) == address(0)) revert SwapNotSet();
        intent.status = IntentStatus.Settled;
    }

    /// @dev Funds (intent.amountIn of intent.tokenIn) are already in this contract.
    ///      Swap output is measured as this contract's own XSGD balance delta, so a
    ///      misbehaving swap module cannot fake the min-out guard. The allowance is reset
    ///      afterwards so a partially-pulling module can never keep a standing claim on
    ///      funds held here (e.g. front-run strandings awaiting rescue). The merchant
    ///      receives the full delta minus the protocol fee.
    function _settle(bytes32 intentId, PaymentIntent storage intent, address payer) internal {
        uint256 xsgdOut;
        if (intent.tokenIn == address(XSGD)) {
            xsgdOut = intent.amountIn;
        } else {
            IERC20(intent.tokenIn).forceApprove(address(swap), intent.amountIn);
            uint256 balanceBefore = XSGD.balanceOf(address(this));
            swap.swapExactIn(intent.tokenIn, intent.amountIn, intent.xsgdAmount, address(this));
            xsgdOut = XSGD.balanceOf(address(this)) - balanceBefore;
            if (xsgdOut < intent.xsgdAmount) revert InsufficientXsgdOut(xsgdOut, intent.xsgdAmount);
            IERC20(intent.tokenIn).forceApprove(address(swap), 0);
        }

        uint256 feeXsgd = (xsgdOut * feeBps) / 10_000;
        if (feeXsgd > 0) {
            XSGD.safeTransfer(feeRecipient, feeXsgd);
        }
        XSGD.safeTransfer(merchants[intent.merchantId].payout, xsgdOut - feeXsgd);
        emit IntentSettled(
            intentId, intent.merchantId, payer, intent.tokenIn, intent.amountIn, xsgdOut, feeXsgd, intent.door
        );
    }

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
