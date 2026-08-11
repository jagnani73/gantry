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
    /// @dev The display fields live HERE, on-chain, rather than in a backend table.
    ///      They were off-chain until 11 Aug 2026, which made the cache the only source
    ///      for something the chain could not re-supply: two hosts indexing the same
    ///      chain rendered different shop names, and the edit route had to be
    ///      unauthenticated and gated by host class. On-chain they are self-attested but
    ///      identical everywhere, and the backend's SQLite becomes a pure cache with no
    ///      exception. Empty is legal — every surface falls back to the handle — because
    ///      requiring them here would put a display rule inside the settlement contract.
    struct Merchant {
        address payout;
        uint16 categoryId;
        string handle;
        string displayName;
        string location;
        string blurb;
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
    /// @dev Every wallet policy error fits in 100 bytes (selector + <=3 words).
    uint256 public constant MAX_DENIAL_REASON_BYTES = 256;

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
    /// @dev `field` is the JSON name the clients already use ("displayName", "location",
    ///      "blurb"), so a revert names the input a form can point at without a lookup
    ///      table that could drift from the struct.
    error ProfileTooLong(string field, uint256 length);
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
    error InvalidDenialReason(uint256 length);

    // ---------------------------------------------------------------- events

    event MerchantRegistered(bytes32 indexed merchantId, string handle, address payout, uint16 categoryId);
    event MerchantPayoutUpdated(bytes32 indexed merchantId, address payout);
    event MerchantProfileUpdated(bytes32 indexed merchantId, string displayName, string location, string blurb);
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
    /// @dev Emitted ALONGSIDE IntentCancelled when the cancellation is a policy
    ///      denial. `wallet` is the agent wallet that refused, indexed because it
    ///      is what a payer's denial list filters on; `reason` is the wallet's
    ///      verbatim revert data. See `cancelIntentWithReason`.
    event IntentDenied(bytes32 indexed intentId, address indexed wallet, bytes reason);
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
    function registerMerchant(
        string calldata handle,
        address payout,
        uint16 categoryId,
        string calldata displayName,
        string calldata location,
        string calldata blurb
    ) external returns (bytes32 merchantId) {
        if (payout == address(0)) revert ZeroAddress();
        if (categoryId >= 256) revert InvalidCategory(categoryId);
        _validateHandle(handle);
        _validateProfile(displayName, location, blurb);

        merchantId = keccak256(bytes(handle));
        if (merchants[merchantId].payout != address(0)) revert HandleTaken(merchantId);

        merchants[merchantId] = Merchant({
            payout: payout,
            categoryId: categoryId,
            handle: handle,
            displayName: displayName,
            location: location,
            blurb: blurb
        });
        emit MerchantRegistered(merchantId, handle, payout, categoryId);
        // Emitted separately rather than widened into MerchantRegistered: the profile is
        // the one part of a merchant record that changes, so an indexer that wants the
        // current text follows ONE event either way instead of special-casing creation.
        emit MerchantProfileUpdated(merchantId, displayName, location, blurb);
    }

    /// @notice Rewrites a merchant's display record. Relayer-only, deliberately: the
    ///         back-office has no login and no wallet, so a merchant-signed write would
    ///         need both, and a permissionless one would let anyone rename any shop.
    ///         Operator-editable is therefore the honest description — the UI says
    ///         "contact the operator" rather than offering a form that cannot write.
    /// @dev    Handle, payout and category are NOT touched here. The handle is permanent,
    ///         the payout rotates only through `setMerchantPayout` (gated on the payout
    ///         itself, so this relayer power cannot redirect anyone's money), and the
    ///         category has no setter at all.
    function setMerchantProfile(
        bytes32 merchantId,
        string calldata displayName,
        string calldata location,
        string calldata blurb
    ) external onlyRelayer {
        Merchant storage merchant = merchants[merchantId];
        if (merchant.payout == address(0)) revert MerchantNotFound(merchantId);
        _validateProfile(displayName, location, blurb);
        merchant.displayName = displayName;
        merchant.location = location;
        merchant.blurb = blurb;
        emit MerchantProfileUpdated(merchantId, displayName, location, blurb);
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
        _cancelIntent(intentId);
    }

    /// @notice Cancel, and record WHY on-chain — for the one outcome that otherwise
    ///         leaves no trace at all: an agent wallet's policy refusing a spend.
    ///
    /// @dev    The refusal itself never reaches the chain. `authorizeSpend` reverts,
    ///         the relayer catches that in simulation and never broadcasts it, so
    ///         there is no failed transaction — and a reverted one would carry no
    ///         logs anyway, since a revert rolls its events back. The cancellation,
    ///         which DOES succeed, is therefore the only place a denial can leave a
    ///         swept record. Without it the sole evidence was a row in whichever
    ///         backend happened to refuse the payment, so two indexers of the same
    ///         chain disagreed about whether it ever happened.
    ///
    ///         `reason` is the wallet's VERBATIM revert data — selector plus args,
    ///         e.g. `CategoryNotAllowed(uint16)` — not a string or an enum, so the
    ///         indexer decodes it with the same decoder the backend already uses and
    ///         no second error vocabulary can drift from the first.
    ///
    ///         HONEST LABEL. The relayer supplies both `wallet` and `reason`, so
    ///         this record is relayer-ATTESTED, not chain-proven. Be precise about
    ///         what that does and does not mean:
    ///
    ///         - The refusal itself is real: the wallet did revert. But it is NOT
    ///           reproducible by a third party. `authorizeSpend` checks the agent's
    ///           signature FIRST, and that signature is never stored, never emitted
    ///           and not in this record — so anyone re-simulating gets
    ///           `InvalidAgentSignature`, whatever the true reason was.
    ///         - What IS checkable against public state at this block: a
    ///           `CategoryNotAllowed` against `wallet.policy().categoryBitmap` and
    ///           the merchant's `categoryId`; a `PerTxCapExceeded` against
    ///           `policy().perTxCap` and `getIntent().amountIn`; a `PolicyExpired`
    ///           against `policy().expiry`. `DailyCapExceeded` needs archive
    ///           `spentToday()`, and `InsufficientWalletBalance` is not checkable.
    ///         - The intent stores no wallet, so the `wallet`↔intent binding cannot
    ///           be verified on-chain at all. It is the relayer's word.
    ///
    ///         `cancelIntent` was already `onlyRelayer`, so this widens no one's
    ///         access — but it does widen what that key can WRITE: a status change
    ///         becomes a permanent, replicated, attributed record naming a third
    ///         party. The Agent-door guard below is what keeps that from being
    ///         pointed at an arbitrary address on an arbitrary intent.
    function cancelIntentWithReason(bytes32 intentId, address wallet, bytes calldata reason)
        external
        onlyRelayer
    {
        if (wallet == address(0)) revert ZeroAddress();
        // Bounded because calldata is the cost here and the relayer pays it. Every
        // policy error in the wallet fits in 100 bytes (a selector plus at most
        // three words); 256 leaves room without leaving a hole to stuff a payload
        // through on a key the whole demo depends on.
        if (reason.length == 0 || reason.length > MAX_DENIAL_REASON_BYTES) {
            revert InvalidDenialReason(reason.length);
        }
        // Agent-door only, the same invariant settleFromPBM enforces and for the
        // same reason: a denial recorded against a human QR intent would render on
        // a payer's screen as their agent being refused, on an intent no agent was
        // ever party to. Checked AFTER _cancelIntent so the lifecycle answer wins —
        // a settled or unknown intent must still revert IntentAlreadySettled /
        // UnknownIntent, which the bridge's resolver reads as evidence.
        if (_cancelIntent(intentId).door != Door.Agent) revert NotAgentIntent(intentId);
        // Emitted BESIDE IntentCancelled, never instead of it: everything that
        // already follows cancellations keeps working untouched, and only the
        // indexer needs to know this second event exists.
        emit IntentDenied(intentId, wallet, reason);
    }

    function _cancelIntent(bytes32 intentId) internal returns (PaymentIntent storage intent) {
        intent = _requirePending(intentId);
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
        IERC3009(intent.tokenIn)
            .transferWithAuthorization(
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
        IAgentPBMWallet(pbmWallet)
            .authorizeSpend(
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

    /**
     * @dev Length only, in BYTES, and deliberately four times the clients' limits
     *      (60/80/140 CODEPOINTS in the shared package's PROFILE_LIMITS).
     *
     *      That factor is the point. A UTF-8 codepoint is at most 4 bytes, so a string
     *      the shared validator accepts can never exceed the bound here — the client rule
     *      is always the binding one and this is a pure anti-abuse ceiling. Matching the
     *      numbers instead would create the drift trap the agent label already documents:
     *      the contract counting bytes while the form counts codepoints means a form that
     *      says 60/60 submitting a transaction that reverts.
     *
     *      Everything else the shared validator enforces — trimming, blank rejection,
     *      bidi overrides, zero-width padding — stays off-chain on purpose. Those are
     *      rendering rules; they belong where the rendering is, not in the contract that
     *      settles payments.
     */
    function _validateProfile(string calldata displayName, string calldata location, string calldata blurb)
        internal
        pure
    {
        if (bytes(displayName).length > 240) revert ProfileTooLong("displayName", bytes(displayName).length);
        if (bytes(location).length > 320) revert ProfileTooLong("location", bytes(location).length);
        if (bytes(blurb).length > 560) revert ProfileTooLong("blurb", bytes(blurb).length);
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
