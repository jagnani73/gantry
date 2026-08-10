// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAgentPBMWallet} from "./interfaces/IAgentPBMWallet.sol";

/// @title AgentPBMWallet — purpose-bound money for AI agents
/// @notice A human owner funds this wallet and sets a spend policy; an agent holds only
///         a session key. Every spend is authorized on-chain: GantryCore calls
///         authorizeSpend during settleFromPBM, this contract verifies the session key's
///         EIP-712 signature plus every policy dimension, then pushes the funds to the
///         core. Policy violations revert with named errors (CategoryNotAllowed & co.)
///         that bubble through the core to the x402 facilitator as decodable reasons —
///         denials are contract law, never backend if-statements.
/// @dev    Caps are denominated in the spend token's own 6dp units and tracked globally
///         across tokens — a deliberate demo simplification (the wallet is funded with a
///         single USD-pegged 6dp stable). Mixing tokens of different value under one cap
///         would conflate units; a production wallet would track per-token.
///
///         Replay safety leans on the core: authorizeSpend is onlyCore, and GantryCore
///         flips an intent to Settled before this call (checks-effects-interactions), so
///         the same intentId can never be presented twice. The wallet therefore keeps no
///         per-intent ledger. The signature carries no deadline — its practical lifetime
///         is bounded by the intent's own TTL and Pending status at the core.
contract AgentPBMWallet is IAgentPBMWallet, Ownable2Step {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- types

    /// @dev dailyCap/perTxCap are in the spend token's units (6dp stables). expiry is
    ///      the last second at which spends are allowed; an unset or revoked policy has
    ///      expiry 0 and is therefore expired-by-default. categoryBitmap: bit n set =
    ///      merchant categoryId n allowed (GantryCore caps categoryId < 256).
    struct Policy {
        uint128 dailyCap;
        uint128 perTxCap;
        uint40 expiry;
        uint256 categoryBitmap;
    }

    // ---------------------------------------------------------------- storage

    address public immutable CORE;

    address public agentSigner;
    uint256 private _lock = 1;

    Policy public policy;

    /// @dev Day-bucketed spend tracking (UTC days: block.timestamp / 1 days). Packed in
    ///      one slot; _spentToday can never exceed policy.dailyCap (uint128), so the
    ///      downcast in authorizeSpend is safe.
    uint64 private _lastSpendDay;
    uint128 private _spentToday;

    /// @notice When the policy was last written — set by setPolicy AND revoke. 0 means a
    ///         wallet whose policy has never been armed.
    /// @dev    Declared HERE rather than beside `policy` so it packs into the slot above:
    ///         64 + 128 + 40 = 232 bits. A struct member variable owns whole slots, so
    ///         adding this to Policy would cost a slot AND put a field in the setter's
    ///         calldata that the contract only overwrites. It exists because the answer
    ///         has no other cheap source: the client alternative is a backwards getLogs
    ///         walk per wallet, bounded, on a rate-limited endpoint, that still cannot
    ///         answer for a policy older than the window it searched.
    uint40 public policyUpdatedAt;

    /// @notice The owner's private label for this wallet ("Kopi Runner"). Display only —
    ///         nothing on-chain reads it, and it may be empty, in which case every screen
    ///         falls back to the short address.
    /// @dev    NOT called `name`: DOMAIN_SEPARATOR() hashes the literal "AgentPBMWallet",
    ///         and a name() getter beside it invites someone to wire the two together —
    ///         at which point every agent signature dies the moment an owner renames.
    string public label;

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    // Canonical EIP-712 encoding — no spaces. The TypeScript builder in packages/shared
    // (agentPolicy.ts) must produce byte-identical typed data or every signature dies as
    // InvalidAgentSignature; a shared test vector pins the two together.
    bytes32 public constant SPEND_AUTHORIZATION_TYPEHASH =
        keccak256("SpendAuthorization(bytes32 intentId,address token,uint256 amount)");

    // ---------------------------------------------------------------- errors

    error ZeroAddress();
    error NotCore();
    error InvalidAgentSignature();
    error PolicyExpired();
    error CategoryNotAllowed(uint16 categoryId);
    error PerTxCapExceeded(uint256 amount, uint256 cap);
    error DailyCapExceeded(uint256 attempted, uint256 cap);
    error InsufficientWalletBalance(uint256 balance, uint256 needed);
    error Reentrancy();
    error OwnershipCannotBeRenounced();
    error LabelTooLong(uint256 length);

    // ---------------------------------------------------------------- events

    event PolicySet(uint128 dailyCap, uint128 perTxCap, uint40 expiry, uint256 categoryBitmap);
    event PolicyRevoked();
    event AgentSignerUpdated(address agentSigner);
    event LabelSet(string label);
    /// @dev spentTodayAfter lets the dashboard's cap meter be a dumb read — no client-side
    ///      replication of day-bucket or setPolicy resets.
    event SpendAuthorized(bytes32 indexed intentId, address indexed token, uint256 amount, uint256 spentTodayAfter);
    event Withdrawn(address indexed token, address to, uint256 amount);

    // ---------------------------------------------------------------- modifiers

    modifier onlyCore() {
        // authorizeSpend pushes funds to msg.sender and the wallet keeps no per-intent
        // ledger, so this gate is what makes signatures single-use in practice (replay
        // safety leans on the core's Settled flip) and stops a direct caller from
        // redirecting the push to themselves. Strangers routing their own intents
        // through the permissionless core are stopped by the signature check, not here.
        if (msg.sender != CORE) revert NotCore();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ---------------------------------------------------------------- setup

    /// @dev `label_` may be empty — an agent does not need a name to be armed, and
    ///      requiring one would put a display field in front of the two transactions that
    ///      actually create and arm the wallet.
    constructor(address owner_, address agentSigner_, address core_, string memory label_) Ownable(owner_) {
        if (agentSigner_ == address(0) || core_ == address(0)) revert ZeroAddress();
        agentSigner = agentSigner_;
        CORE = core_;
        _setLabel(label_);
    }

    // ---------------------------------------------------------------- spend authorization

    /// @inheritdoc IAgentPBMWallet
    /// @dev Check order is deliberate and pinned by tests — these names are read on
    ///      stage, so which error fires for a given denial must be deterministic:
    ///      signature → expiry → category → per-tx cap → daily cap → balance.
    function authorizeSpend(bytes32 intentId, uint16 categoryId, address token, uint256 amount, bytes calldata agentSig)
        external
        onlyCore
        nonReentrant
    {
        bytes32 structHash = keccak256(abi.encode(SPEND_AUTHORIZATION_TYPEHASH, intentId, token, amount));
        (uint8 v, bytes32 r, bytes32 s) = _splitSignature(agentSig);
        _verifySignature(agentSigner, structHash, v, r, s);

        Policy memory p = policy;
        if (block.timestamp > p.expiry) revert PolicyExpired();
        // Shifts of 256+ yield 0 in Solidity, so an out-of-range categoryId (impossible
        // via the core's registry) safely denies rather than reverting oddly. The shift
        // direction is intentional: bit N of the bitmap gates categoryId N.
        // forge-lint: disable-next-line(incorrect-shift)
        if (p.categoryBitmap & (1 << categoryId) == 0) revert CategoryNotAllowed(categoryId);
        if (amount > p.perTxCap) revert PerTxCapExceeded(amount, p.perTxCap);

        uint256 today = block.timestamp / 1 days;
        uint256 attempted = (_lastSpendDay == today ? _spentToday : 0) + amount;
        if (attempted > p.dailyCap) revert DailyCapExceeded(attempted, p.dailyCap);

        // Pre-check the balance so an underfunded wallet surfaces one deterministic,
        // wallet-named reason instead of whatever shape the token reverts with (OZ
        // custom error on the mock, string revert on real USDC).
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance < amount) revert InsufficientWalletBalance(balance, amount);

        // casting to 'uint64' is safe: block.timestamp / 1 days fits for ~10^16 years
        // forge-lint: disable-next-line(unsafe-typecast)
        _lastSpendDay = uint64(today);
        // casting to 'uint128' is safe: the daily-cap check above bounds attempted <= dailyCap (uint128)
        // forge-lint: disable-next-line(unsafe-typecast)
        _spentToday = uint128(attempted);

        // The core measures its own balance delta — the wallet PUSHES; nothing pulls.
        IERC20(token).safeTransfer(msg.sender, amount);
        emit SpendAuthorized(intentId, token, amount, attempted);
    }

    // ---------------------------------------------------------------- owner

    /// @notice Replaces the whole policy. Deliberately also resets the daily spend
    ///         counter — a policy update means a fresh window. (This is what lets the
    ///         demo re-arm the wallet between rehearsals without waiting for midnight.)
    /// @dev No cross-field validation: a perTxCap above dailyCap is harmless (dailyCap
    ///      binds) and a past expiry is just a revoked policy.
    function setPolicy(Policy calldata newPolicy) external onlyOwner {
        _setPolicy(newPolicy);
    }

    /// @notice Zeroes the policy — the dashboard's Revoke button. Subsequent spends
    ///         revert PolicyExpired (expiry 0 is expired-by-default); setPolicy re-arms.
    function revoke() external onlyOwner {
        _setPolicy(Policy({dailyCap: 0, perTxCap: 0, expiry: 0, categoryBitmap: 0}));
        emit PolicyRevoked();
    }

    /// @notice Renames the wallet. Display only — no spend behaviour changes, and the
    ///         daily counter is untouched (unlike setPolicy, which resets it).
    function setLabel(string calldata newLabel) external onlyOwner {
        _setLabel(newLabel);
    }

    /// @notice Rotates the agent's session key. Does not reset the daily spend counter —
    ///         a new key does not buy a fresh budget.
    function setAgentSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        agentSigner = newSigner;
        emit AgentSignerUpdated(newSigner);
    }

    /// @notice Owner reclaims funds — this is the owner's own money, not a rescue path.
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    /// @dev A wallet with no owner would strand its funds and freeze its policy forever.
    function renounceOwnership() public pure override {
        revert OwnershipCannotBeRenounced();
    }

    // ---------------------------------------------------------------- views

    /// @notice Spend so far in the current UTC day — 0 whenever the last spend (or
    ///         setPolicy reset) happened on any day other than today.
    function spentToday() public view returns (uint256) {
        return _lastSpendDay == block.timestamp / 1 days ? _spentToday : 0;
    }

    /// @dev Computed per call with block.chainid so signatures stay valid on forks/anvil.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256("AgentPBMWallet"), keccak256("1"), block.chainid, address(this)
            )
        );
    }

    // ---------------------------------------------------------------- internal

    function _setPolicy(Policy memory newPolicy) internal {
        policy = newPolicy;
        // casting to 'uint64' is safe: block.timestamp / 1 days fits for ~10^16 years
        // forge-lint: disable-next-line(unsafe-typecast)
        _lastSpendDay = uint64(block.timestamp / 1 days);
        _spentToday = 0;
        // The one choke point both setPolicy and revoke pass through, which is what makes
        // this the whole answer: a revoked wallet dates from its revoke, not from the
        // arming before it.
        // casting to 'uint40' is safe: uint40 seconds overflows in the year 36812
        // forge-lint: disable-next-line(unsafe-typecast)
        policyUpdatedAt = uint40(block.timestamp);
        emit PolicySet(newPolicy.dailyCap, newPolicy.perTxCap, newPolicy.expiry, newPolicy.categoryBitmap);
    }

    /// @dev 31 BYTES, not 31 characters — the contract counts bytes, so a label of emoji
    ///      runs out four times faster than one of ASCII and any client-side counter must
    ///      count the same way. 31 is where a Solidity string still lives inline in its
    ///      own slot; this is a nickname, not a bio.
    function _setLabel(string memory newLabel) private {
        if (bytes(newLabel).length > 31) revert LabelTooLong(bytes(newLabel).length);
        label = newLabel;
        emit LabelSet(newLabel);
    }

    function _verifySignature(address signer, bytes32 structHash, uint8 v, bytes32 r, bytes32 s) internal view {
        // Reject malleable high-s signatures and bad v, same bounds as the EIP-3009
        // layer — one signature-validity story across the whole stack.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert InvalidAgentSignature();
        }
        if (v != 27 && v != 28) revert InvalidAgentSignature();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0) || recovered != signer) revert InvalidAgentSignature();
    }

    function _splitSignature(bytes memory signature) internal pure returns (uint8 v, bytes32 r, bytes32 s) {
        if (signature.length != 65) revert InvalidAgentSignature();
        assembly ("memory-safe") {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
    }
}
