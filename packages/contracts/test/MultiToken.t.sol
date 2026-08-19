// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GantryTestBase} from "./helpers/GantryTestBase.sol";
import {GantryCore} from "../src/GantryCore.sol";
import {FixedRateSwap} from "../src/FixedRateSwap.sol";
import {MockStablecoin} from "../src/mocks/MockStablecoin.sol";
import {Eip3009Digest} from "./helpers/Eip3009Digest.sol";

/// @notice A SECOND payer token settling through the same `_settle` as USDC.
///
/// The point of these tests is that adding a payer currency needs no change to
/// `GantryCore` at all: it holds no token allowlist, and `FixedRateSwap.rateOf`
/// is an open owner-set mapping. Everything below is exercised against a token
/// the fixture invents at runtime, so it proves the path rather than the
/// particular token — which is what makes it evidence for a currency we have
/// not deployed yet.
contract MultiTokenTest is GantryTestBase {
    MockStablecoin internal inr;

    // XSGD 6dp out per 1e6 INR in. Round by construction: 1 SGD is treated as
    // 65 rupees exactly, so 1e6/65 = 15_384.6 -> 15_385. A round rate cannot be
    // mistaken for a market quote, which is the same reason the shared display
    // table uses one.
    uint256 internal constant INR_RATE = 15_385;

    function setUp() public override {
        super.setUp();
        inr = new MockStablecoin("Mock INR", "INRX");
        swap.setRate(address(inr), INR_RATE);
        inr.mint(payer, 1_000_000e6);
    }

    // The ceil quote from the shared quote module, restated here so the two
    // cannot drift: a FLOORED quote swaps to less than `xsgdAmount`, and the
    // swap's own min-out then refuses the settle.
    function _quote(uint128 xsgdAmount, uint256 rate) internal pure returns (uint128) {
        return uint128((uint256(xsgdAmount) * 1e6 + rate - 1) / rate);
    }

    function test_settlesInASecondPayerToken() public {
        uint128 amountIn = _quote(XSGD_AMOUNT, INR_RATE);
        // S$6.50 at ₹65/S$ is about ₹422.50.
        assertApproxEqAbs(uint256(amountIn), 422_500_000, 1_000_000, "quote is not ~422.50 INR");

        bytes32 intentId = _createIntent(address(inr), amountIn, GantryCore.Door.Human);

        uint256 payoutBefore = xsgd.balanceOf(payout);
        _settleWithFreshSig(intentId, address(inr), amountIn);

        // The merchant is paid XSGD, never the token the payer sent — the whole
        // claim of the feature, asserted on balances rather than on an event.
        uint256 received = xsgd.balanceOf(payout) - payoutBefore;
        assertEq(received, XSGD_AMOUNT, "merchant did not receive the full XSGD price");
        assertEq(inr.balanceOf(payout), 0, "merchant was paid in the payer's token");
        assertEq(inr.balanceOf(address(core)), 0, "core retained payer token");
    }

    /// A settle quoted against a better rate than the swap lists cannot pay the
    /// merchant, and the refusal comes from the SWAP.
    ///
    /// The core passes `intent.xsgdAmount` down as `minOut`, so `swapExactIn`
    /// reverts `InsufficientOutput` before the core's own balance-delta guard
    /// (`InsufficientXsgdOut`) is ever reached. Two layers, and this is the
    /// outer one; the core's is exercised directly in
    /// `GantryCore.settleAuth.t.sol` against a deliberately short swap.
    ///
    /// Worth pinning the selector rather than accepting any revert: this test
    /// asserted the CORE's guard for as long as it used a bare `expectRevert`,
    /// and would have passed on a build where that guard had been deleted.
    function test_minOutHoldsForTheNewToken() public {
        // Quote against a better rate than the swap is actually listing, so the
        // swap returns less XSGD than the intent promises.
        uint128 underQuoted = _quote(XSGD_AMOUNT, INR_RATE * 2);
        bytes32 intentId = _createIntent(address(inr), underQuoted, GantryCore.Door.Human);

        (uint8 v, bytes32 r, bytes32 s) =
            _signAuth(address(inr), underQuoted, block.timestamp + 1 hours, intentId);
        // `expectPartialRevert`, so the SELECTOR is pinned and its two amounts
        // are not: `got` falls out of the ceil quote and the rate, and asserting
        // it would turn this into a rounding check. Which guard fired is the
        // fact worth holding. (`expectRevert(bytes4)` compares the whole revert
        // payload here, so it would demand an argument-less error.)
        vm.expectPartialRevert(FixedRateSwap.InsufficientOutput.selector);
        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);

        assertEq(xsgd.balanceOf(payout), 0, "merchant was paid despite an under-delivering swap");
    }

    /// Listing is what admits a token, and it is `onlyOwner`. An unlisted token
    /// cannot be settled even though `createIntent` accepted it — which is why
    /// an open-mint mock existing in the tree is not itself a hole.
    function test_unlistedTokenCannotSettle() public {
        MockStablecoin rogue = new MockStablecoin("Mock THB", "THBX");
        rogue.mint(payer, 1_000_000e6);

        bytes32 intentId = _createIntent(address(rogue), 100_000_000, GantryCore.Door.Human);
        (uint8 v, bytes32 r, bytes32 s) =
            _signAuth(address(rogue), 100_000_000, block.timestamp + 1 hours, intentId);

        vm.expectRevert(abi.encodeWithSelector(FixedRateSwap.TokenUnsupported.selector, address(rogue)));
        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);
    }

    /// Delisting is `setRate(token, 0)` and takes effect immediately — the
    /// operational undo for a rate that turns out wrong, with no redeploy.
    function test_delistingStopsFurtherSettlement() public {
        uint128 amountIn = _quote(XSGD_AMOUNT, INR_RATE);
        bytes32 first = _createIntent(address(inr), amountIn, GantryCore.Door.Human);
        _settleWithFreshSig(first, address(inr), amountIn);
        assertEq(xsgd.balanceOf(payout), XSGD_AMOUNT, "first payment did not settle");

        swap.setRate(address(inr), 0);

        bytes32 second = _createIntent(address(inr), amountIn, GantryCore.Door.Human);
        (uint8 v, bytes32 r, bytes32 s) =
            _signAuth(address(inr), amountIn, block.timestamp + 1 hours, second);
        vm.expectRevert(abi.encodeWithSelector(FixedRateSwap.TokenUnsupported.selector, address(inr)));
        core.settleWithAuthorization(second, payer, 0, block.timestamp + 1 hours, v, r, s);
    }

    /// The mock's EIP-712 domain has to be derivable the way a client derives it,
    /// or a payer signs a digest the token rejects. `version()` is the field the
    /// backend's boot assertion reads live, so it is pinned here too.
    function test_domainIsDerivableFromNameAndVersion() public view {
        assertEq(inr.version(), "1", "version drifted from the mock convention");
        assertEq(inr.decimals(), 6, "a non-6dp token would break the swap's 1e6 scale");
        // Derived from name/version/chainId/address the way a client does it,
        // rather than read off the contract — so this fails if the two disagree.
        assertEq(
            inr.DOMAIN_SEPARATOR(),
            Eip3009Digest.domainSeparator(inr.name(), inr.version(), block.chainid, address(inr)),
            "client-derived domain does not match the token"
        );
    }

    /// A nonce is single-use per authorizer on the new token exactly as on USDC —
    /// the property that makes `nonce == intentId` a replay guard rather than a
    /// convention.
    function test_authorizationCannotBeReplayed() public {
        uint128 amountIn = _quote(XSGD_AMOUNT, INR_RATE);
        bytes32 intentId = _createIntent(address(inr), amountIn, GantryCore.Door.Human);

        (uint8 v, bytes32 r, bytes32 s) =
            _signAuth(address(inr), amountIn, block.timestamp + 1 hours, intentId);
        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);

        assertTrue(inr.authorizationState(payer, intentId), "nonce was not marked used");
        vm.expectRevert();
        core.settleWithAuthorization(intentId, payer, 0, block.timestamp + 1 hours, v, r, s);
    }
}
