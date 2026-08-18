// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {AgentPBMWallet} from "../src/AgentPBMWallet.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {PbmDigest} from "./helpers/PbmDigest.sol";

/// @notice Drives the wallet the way the world does: an agent signing spends through the
///         core, an owner re-arming and revoking, and time moving across day boundaries.
/// @dev    Extends CommonBase + StdUtils rather than Test ON PURPOSE. Test's own public
///         functions would be fuzzed as if they were handler actions, which quietly
///         wastes most of a run; this gets `vm` and `bound` and exposes nothing else.
///         The invariant contract also names the four selectors explicitly, so adding a
///         helper here can never silently become a fuzz target.
contract PolicyHandler is CommonBase, StdUtils {
    AgentPBMWallet internal immutable WALLET;
    MockUSDC internal immutable USDC;
    address internal immutable CORE;
    address internal immutable OWNER;
    uint256 internal immutable AGENT_PK;

    /// Ghost variables. Each one exists because the property it records is about the
    /// HISTORY of the run, which no single view of the contract can answer.
    uint256 public successes;
    /// Spends that landed while the policy stood revoked and un-rearmed.
    uint256 public spendsWhileRevoked;
    /// Spends that landed for a category whose bit was not set at the time.
    uint256 public spendsOutsideBitmap;
    /// Spends that landed above the per-transaction cap in force.
    uint256 public spendsOverPerTxCap;

    bool internal revoked;
    uint256 internal seq;

    constructor(AgentPBMWallet wallet_, MockUSDC usdc_, address core_, address owner_, uint256 agentPk_) {
        WALLET = wallet_;
        USDC = usdc_;
        CORE = core_;
        OWNER = owner_;
        AGENT_PK = agentPk_;
    }

    /// @notice A correctly signed spend. The signature is always VALID — an invalid one
    ///         would be refused at the first check and tell us nothing about the policy,
    ///         which is what these invariants are about.
    function spend(uint256 amountSeed, uint256 categorySeed) external {
        // Read the policy BEFORE the call: the assertions below are about the rules that
        // were in force when it was admitted, and a later re-arm would rewrite them.
        (uint128 dailyCap, uint128 perTxCap,, uint256 bitmap) = WALLET.policy();
        bool wasRevoked = revoked;

        // Steered, not blind. A uniformly random category and amount almost never clears
        // every check at once, so a short campaign admits nothing and the properties hold
        // over an empty set — which is precisely the failure `afterInvariant` caught.
        //
        // Steering is FORCED until the run has landed its first spend, and optional after.
        // `afterInvariant` fails a run that never admitted anything, so a run's first
        // success cannot be left to chance: at half-steering it was not, and the suite
        // failed 5 times in 20. Once the happy path is proven the draws go back to being
        // half unguided, so the refusal paths and the out-of-policy ghosts are still
        // exercised for the rest of the depth — which is the part that has to stay random.
        bool mustSucceed = successes == 0;
        uint16 categoryId;
        (uint16 allowed, bool found) = _allowedCategory(bitmap, categorySeed);
        if (found && (mustSucceed || categorySeed % 2 == 0)) {
            categoryId = allowed;
        } else {
            categoryId = uint16(bound(categorySeed, 0, 6));
        }

        // The per-tx cap is not the only ceiling a spend has to clear: `spentToday` is
        // deducted from the daily cap, so an amount inside perTxCap still reverts once the
        // day is nearly spent. A steered draw that ignores the headroom is therefore only
        // *probably* admissible, and that residual is what kept the suite flaking after
        // the caps were bounded. Aim at whichever ceiling actually binds.
        uint256 headroom = dailyCap > WALLET.spentToday() ? dailyCap - WALLET.spentToday() : 0;
        uint256 admissible = perTxCap < headroom ? perTxCap : headroom;
        uint256 ceiling = perTxCap == 0 ? 1 : uint256(perTxCap);
        uint256 amount;
        if (mustSucceed && admissible > 0) {
            amount = bound(amountSeed, 1, admissible);
        } else {
            amount = categorySeed % 2 == 0 ? bound(amountSeed, 1, ceiling) : bound(amountSeed, 1, ceiling * 2 + 1);
        }

        bytes32 intentId = keccak256(abi.encode("invariant-spend", seq++));
        bytes32 digest = PbmDigest.spendDigest(address(WALLET), intentId, address(USDC), amount);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, digest);

        vm.prank(CORE);
        try WALLET.authorizeSpend(intentId, categoryId, address(USDC), amount, abi.encodePacked(r, s, v)) {
            successes++;
            if (wasRevoked) spendsWhileRevoked++;
            if (bitmap & (uint256(1) << categoryId) == 0) spendsOutsideBitmap++;
            if (amount > perTxCap) spendsOverPerTxCap++;
        } catch {
            // A refusal is the expected outcome for most fuzzed inputs and proves nothing
            // on its own. The invariants are about what got THROUGH.
        }
    }

    /// @dev Pick one category the bitmap admits. Bounded at 32 because `rearm` bounds the
    ///      bitmap to uint32; the CONTRACT allows any id under 256, which is exactly why
    ///      the other half of the draws stays unguided.
    function _allowedCategory(uint256 bitmap, uint256 seed) internal pure returns (uint16, bool) {
        uint256 count;
        for (uint256 i = 0; i < 32; i++) {
            if (bitmap & (uint256(1) << i) != 0) count++;
        }
        if (count == 0) return (0, false);
        uint256 pick = seed % count;
        for (uint256 i = 0; i < 32; i++) {
            if (bitmap & (uint256(1) << i) != 0) {
                if (pick == 0) return (uint16(i), true);
                pick--;
            }
        }
        return (0, false);
    }

    /// @notice Move time, including across the UTC day boundary the daily window rolls on.
    /// @dev    Kept SMALL on purpose. A run is hundreds of calls, so a warp of up to
    ///         three days marches time by a year or more and every policy is expired
    ///         long before it is tested — the properties then hold over a wallet that
    ///         refuses everything. Up to six hours still crosses the 08:00 SGT rollover
    ///         regularly, which is the boundary the daily counter actually turns on.
    function warpAhead(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1 minutes, 6 hours));
    }

    function revokeNow() external {
        vm.prank(OWNER);
        WALLET.revoke();
        revoked = true;
    }

    /// @dev Every re-armed policy must admit SOMETHING, and the bounds below are what
    ///      enforce that. Unbounded, this could draw a dud — a zero per-tx cap, a zero
    ///      daily cap, an empty bitmap — and a run that drew one early admitted no spend
    ///      for the rest of its depth, which `afterInvariant` then failed. Measured at
    ///      **5 failures in 20 suite runs** before this bound: a red CI one run in four,
    ///      on a repo judges clone, for a contract that was never wrong.
    ///
    ///      It costs no coverage. A policy that admits nothing is exactly what `revoke()`
    ///      produces, and `revokeNow()` is already a fuzz target — so the degenerate state
    ///      is still reached, by the path that means it. The refusal paths stay exercised
    ///      through `spend`'s unsteered half, which still draws categories outside the
    ///      bitmap and amounts above the cap.
    function rearm(uint256 dailyCapSeed, uint256 perTxCapSeed, uint256 ttlSeed, uint256 bitmapSeed) external {
        uint128 perTxCap = uint128(bound(perTxCapSeed, 1e6, 1_000e6));
        AgentPBMWallet.Policy memory next = AgentPBMWallet.Policy({
            // Never below the per-tx cap, so the daily ceiling cannot be the thing that
            // silently admits nothing — the per-tx cap alone decides what a single spend
            // may be, and that is the property the bound above protects.
            dailyCap: uint128(bound(dailyCapSeed, perTxCap, 2_000e6)),
            perTxCap: perTxCap,
            // Spans both sides of the interesting line: short enough to expire mid-run
            // (so PolicyExpired is exercised) and long enough that many re-arms outlive
            // the warps that follow (so spends are actually admitted).
            expiry: uint40(block.timestamp + bound(ttlSeed, 1 hours, 400 days)),
            // Non-empty, for the reason above: an empty bitmap refuses every category.
            categoryBitmap: bound(bitmapSeed, 1, type(uint32).max)
        });
        vm.prank(OWNER);
        WALLET.setPolicy(next);
        revoked = false;

        // Keep the wallet solvent. authorizeSpend PUSHES tokens out, so without this the
        // balance pre-check becomes the only reason anything is refused and every policy
        // property below passes for the wrong reason.
        USDC.mint(address(WALLET), 10_000e6);
    }
}

/// @notice Properties of the spend policy that must hold over any sequence of signed
///         spends, re-arms, revokes and day rollovers.
/// @dev    These are stronger claims than the unit tests beside them: a unit test fixes
///         one ordering, an invariant asserts over the orderings the fuzzer finds. The
///         revoke property in particular is the one the payer app promises out loud —
///         "every payment after it reverts" — and it was previously only unit-tested.
contract AgentPBMWalletInvariants is Test {
    AgentPBMWallet internal wallet;
    MockUSDC internal usdc;
    PolicyHandler internal handler;

    uint256 internal constant AGENT_PK = 0xA6E27;

    function setUp() public {
        vm.warp(1_755_000_000);
        address agent = vm.addr(AGENT_PK);
        address owner = makeAddr("owner");
        address core = makeAddr("core");

        usdc = new MockUSDC();
        wallet = new AgentPBMWallet(owner, agent, core, "");
        usdc.mint(address(wallet), 10_000e6);

        vm.prank(owner);
        wallet.setPolicy(
            AgentPBMWallet.Policy({
                dailyCap: 50e6,
                perTxCap: 20e6,
                expiry: uint40(block.timestamp + 30 days),
                categoryBitmap: uint256(1) << 1
            })
        );

        handler = new PolicyHandler(wallet, usdc, core, owner, AGENT_PK);

        // Explicit, so a helper added to the handler later cannot silently become an
        // action the fuzzer drives.
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = PolicyHandler.spend.selector;
        selectors[1] = PolicyHandler.warpAhead.selector;
        selectors[2] = PolicyHandler.revokeNow.selector;
        selectors[3] = PolicyHandler.rearm.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice The daily counter can never exceed the cap in force.
    /// @dev    Holds across re-arms because `_setPolicy` zeroes the counter and restamps
    ///         the day — otherwise lowering a cap mid-day would break this legitimately.
    function invariant_spentTodayNeverExceedsDailyCap() public view {
        (uint128 dailyCap,,,) = wallet.policy();
        assertLe(wallet.spentToday(), dailyCap, "spentToday exceeded the daily cap");
    }

    /// @notice revoke() is terminal until an owner re-arms.
    /// @dev    This is the claim the Revoke button makes on the payer's phone. `revoke`
    ///         zeroes expiry and `block.timestamp > 0` always, so PolicyExpired denies
    ///         every subsequent spend regardless of caps, category or balance.
    function invariant_revokeIsTerminalUntilRearmed() public view {
        assertEq(handler.spendsWhileRevoked(), 0, "a spend landed on a revoked policy");
    }

    /// @notice What kind of shop is enforced, not merely displayed.
    function invariant_neverSpendsOutsideItsCategories() public view {
        assertEq(handler.spendsOutsideBitmap(), 0, "a spend landed outside the category bitmap");
    }

    /// @notice The per-transaction ceiling binds every single admitted spend.
    function invariant_neverExceedsPerTxCap() public view {
        assertEq(handler.spendsOverPerTxCap(), 0, "a spend landed above the per-tx cap");
    }

    /// @notice The run actually exercised the happy path.
    /// @dev    `afterInvariant`, not an invariant. An invariant is evaluated against the
    ///         initial state as well, where zero successes is correct — asserting it
    ///         there fails before a single call is made. This runs once, at the end.
    ///
    ///         It earns its place: every property above is satisfiable by a wallet that
    ///         refuses everything, and the first version of this handler did exactly
    ///         that. Warps of up to three days marched time past every expiry, so all
    ///         four passed over an empty set and looked like proof.
    function afterInvariant() public view {
        assertGt(handler.successes(), 0, "no spend ever succeeded; the invariants proved nothing");
    }
}
