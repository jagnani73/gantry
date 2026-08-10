// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AgentPBMWallet} from "../src/AgentPBMWallet.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {PbmDigest} from "./helpers/PbmDigest.sol";

/// @notice Unit tests for AgentPBMWallet in isolation — the "core" is a pranked EOA so
///         every policy dimension, signature check, and admin path is exercised without
///         GantryCore in the loop (integration lives in AgentPBMWallet.integration.t.sol).
contract AgentPBMWalletTest is Test {
    AgentPBMWallet internal wallet;
    MockUSDC internal usdc;

    uint256 internal constant AGENT_PK = 0xA6E27;
    address internal agent;
    address internal owner;
    address internal coreAddr;

    uint128 internal constant DAILY_CAP = 50e6;
    uint128 internal constant PER_TX_CAP = 20e6;
    uint16 internal constant CATEGORY = 1;
    uint256 internal constant BITMAP = 1 << 1;

    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    bytes32 internal constant INTENT_ID = keccak256("intent-1");

    function setUp() public virtual {
        vm.warp(1_755_000_000);
        agent = vm.addr(AGENT_PK);
        owner = makeAddr("owner");
        coreAddr = makeAddr("core");

        usdc = new MockUSDC();
        wallet = new AgentPBMWallet(owner, agent, coreAddr, "");
        usdc.mint(address(wallet), 1_000e6);

        vm.prank(owner);
        wallet.setPolicy(_defaultPolicy());
    }

    function _defaultPolicy() internal view returns (AgentPBMWallet.Policy memory) {
        return AgentPBMWallet.Policy({
            dailyCap: DAILY_CAP, perTxCap: PER_TX_CAP, expiry: uint40(block.timestamp + 30 days), categoryBitmap: BITMAP
        });
    }

    function _sig(bytes32 intentId, address token, uint256 amount) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(AGENT_PK, PbmDigest.spendDigest(address(wallet), intentId, token, amount));
        return abi.encodePacked(r, s, v);
    }

    function _spend(bytes32 intentId, uint16 categoryId, uint256 amount) internal {
        bytes memory sig = _sig(intentId, address(usdc), amount);
        vm.prank(coreAddr);
        wallet.authorizeSpend(intentId, categoryId, address(usdc), amount, sig);
    }

    // ---------------------------------------------------------------- constructor

    function test_constructor_wiresOwnerSignerCore() public view {
        assertEq(wallet.owner(), owner);
        assertEq(wallet.agentSigner(), agent);
        assertEq(wallet.CORE(), coreAddr);
    }

    function test_revert_constructor_zeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new AgentPBMWallet(address(0), agent, coreAddr, "");
    }

    function test_revert_constructor_zeroAgentSigner() public {
        vm.expectRevert(AgentPBMWallet.ZeroAddress.selector);
        new AgentPBMWallet(owner, address(0), coreAddr, "");
    }

    function test_revert_constructor_zeroCore() public {
        vm.expectRevert(AgentPBMWallet.ZeroAddress.selector);
        new AgentPBMWallet(owner, agent, address(0), "");
    }

    // ---------------------------------------------------------------- policy admin

    function test_setPolicy_storesAndEmits() public {
        AgentPBMWallet.Policy memory p = AgentPBMWallet.Policy({
            dailyCap: 77e6,
            perTxCap: 33e6,
            expiry: uint40(block.timestamp + 7 days),
            categoryBitmap: (1 << 2) | (1 << 4)
        });

        vm.expectEmit(true, true, true, true, address(wallet));
        emit AgentPBMWallet.PolicySet(p.dailyCap, p.perTxCap, p.expiry, p.categoryBitmap);
        vm.prank(owner);
        wallet.setPolicy(p);

        (uint128 dailyCap, uint128 perTxCap, uint40 expiry, uint256 bitmap) = wallet.policy();
        assertEq(dailyCap, p.dailyCap);
        assertEq(perTxCap, p.perTxCap);
        assertEq(expiry, p.expiry);
        assertEq(bitmap, p.categoryBitmap);
    }

    function test_revert_setPolicy_notOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent));
        vm.prank(agent);
        wallet.setPolicy(_defaultPolicy());
    }

    /// @notice The rehearsal re-arm: setPolicy zeroes the day's spend so a full budget
    ///         is immediately available again — demo-reset depends on this.
    function test_setPolicy_resetsSpentToday() public {
        _spend(INTENT_ID, CATEGORY, PER_TX_CAP);
        assertEq(wallet.spentToday(), PER_TX_CAP);

        vm.prank(owner);
        wallet.setPolicy(_defaultPolicy());
        assertEq(wallet.spentToday(), 0);

        // A fresh full-day budget: the first two spends alone (40e6) exceed the 30e6
        // headroom a carried counter would have left, proving the counter was zeroed;
        // the third lands exactly on the cap.
        _spend(keccak256("r1"), CATEGORY, PER_TX_CAP);
        _spend(keccak256("r2"), CATEGORY, PER_TX_CAP);
        _spend(keccak256("r3"), CATEGORY, 10e6);
        assertEq(wallet.spentToday(), DAILY_CAP);
    }

    function test_revoke_zeroesPolicy_emitsBothEvents() public {
        vm.expectEmit(true, true, true, true, address(wallet));
        emit AgentPBMWallet.PolicySet(0, 0, 0, 0);
        vm.expectEmit(true, true, true, true, address(wallet));
        emit AgentPBMWallet.PolicyRevoked();
        vm.prank(owner);
        wallet.revoke();

        (uint128 dailyCap, uint128 perTxCap, uint40 expiry, uint256 bitmap) = wallet.policy();
        assertEq(dailyCap, 0);
        assertEq(perTxCap, 0);
        assertEq(expiry, 0);
        assertEq(bitmap, 0);

        // expiry 0 means expired-by-default — the Revoke button beat.
        bytes memory sig = _sig(INTENT_ID, address(usdc), 1e6);
        vm.expectRevert(AgentPBMWallet.PolicyExpired.selector);
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), 1e6, sig);
    }

    function test_revoke_thenSetPolicy_reArms() public {
        vm.prank(owner);
        wallet.revoke();
        vm.prank(owner);
        wallet.setPolicy(_defaultPolicy());

        _spend(INTENT_ID, CATEGORY, 1e6);
        assertEq(wallet.spentToday(), 1e6);
    }

    function test_revert_revoke_notOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent));
        vm.prank(agent);
        wallet.revoke();
    }

    // ---------------------------------------------------------------- signer admin

    function test_setAgentSigner_rotates() public {
        uint256 newPk = 0xB0B;
        address newSigner = vm.addr(newPk);

        vm.expectEmit(true, true, true, true, address(wallet));
        emit AgentPBMWallet.AgentSignerUpdated(newSigner);
        vm.prank(owner);
        wallet.setAgentSigner(newSigner);

        // The old key's signatures die...
        bytes memory oldSig = _sig(INTENT_ID, address(usdc), 1e6);
        vm.expectRevert(AgentPBMWallet.InvalidAgentSignature.selector);
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), 1e6, oldSig);

        // ...and the new key's are accepted.
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(newPk, PbmDigest.spendDigest(address(wallet), INTENT_ID, address(usdc), 1e6));
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), 1e6, abi.encodePacked(r, s, v));
    }

    function test_revert_setAgentSigner_zero() public {
        vm.expectRevert(AgentPBMWallet.ZeroAddress.selector);
        vm.prank(owner);
        wallet.setAgentSigner(address(0));
    }

    function test_revert_setAgentSigner_notOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent));
        vm.prank(agent);
        wallet.setAgentSigner(makeAddr("other"));
    }

    // ---------------------------------------------------------------- withdraw / ownership

    function test_withdraw_reclaims_emitsWithdrawn() public {
        address to = makeAddr("treasury");

        vm.expectEmit(true, true, true, true, address(wallet));
        emit AgentPBMWallet.Withdrawn(address(usdc), to, 400e6);
        vm.prank(owner);
        wallet.withdraw(address(usdc), to, 400e6);

        assertEq(usdc.balanceOf(to), 400e6);
        assertEq(usdc.balanceOf(address(wallet)), 600e6);
    }

    function test_revert_withdraw_notOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent));
        vm.prank(agent);
        wallet.withdraw(address(usdc), agent, 1e6);
    }

    function test_revert_withdraw_zeroTo() public {
        vm.expectRevert(AgentPBMWallet.ZeroAddress.selector);
        vm.prank(owner);
        wallet.withdraw(address(usdc), address(0), 1e6);
    }

    function test_renounceOwnership_reverts() public {
        vm.expectRevert(AgentPBMWallet.OwnershipCannotBeRenounced.selector);
        vm.prank(owner);
        wallet.renounceOwnership();
    }

    function test_ownership_twoStepTransfer() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        wallet.transferOwnership(newOwner);
        assertEq(wallet.owner(), owner, "transfer is pending, not immediate");

        vm.prank(newOwner);
        wallet.acceptOwnership();
        assertEq(wallet.owner(), newOwner);
    }

    // ---------------------------------------------------------------- authorizeSpend: happy + gate

    function test_authorizeSpend_happy() public {
        vm.expectEmit(true, true, true, true, address(wallet));
        emit AgentPBMWallet.SpendAuthorized(INTENT_ID, address(usdc), 5e6, 5e6);

        _spend(INTENT_ID, CATEGORY, 5e6);

        assertEq(usdc.balanceOf(coreAddr), 5e6, "funds pushed to the core");
        assertEq(usdc.balanceOf(address(wallet)), 995e6);
        assertEq(wallet.spentToday(), 5e6);
    }

    function test_revert_authorizeSpend_notCore() public {
        bytes memory sig = _sig(INTENT_ID, address(usdc), 5e6);
        // The drain-defense gate: anyone who isn't the core is turned away before any
        // signature or policy logic runs.
        vm.expectRevert(AgentPBMWallet.NotCore.selector);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), 5e6, sig);
    }

    // ---------------------------------------------------------------- authorizeSpend: signature

    function test_revert_wrongSigner() public {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(0xBAD, PbmDigest.spendDigest(address(wallet), INTENT_ID, address(usdc), 5e6));
        vm.expectRevert(AgentPBMWallet.InvalidAgentSignature.selector);
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), 5e6, abi.encodePacked(r, s, v));
    }

    function test_revert_tamperedIntentId() public {
        bytes memory sig = _sig(INTENT_ID, address(usdc), 5e6);
        vm.expectRevert(AgentPBMWallet.InvalidAgentSignature.selector);
        vm.prank(coreAddr);
        wallet.authorizeSpend(keccak256("other-intent"), CATEGORY, address(usdc), 5e6, sig);
    }

    function test_revert_tamperedToken() public {
        MockUSDC otherToken = new MockUSDC();
        otherToken.mint(address(wallet), 1_000e6);
        bytes memory sig = _sig(INTENT_ID, address(usdc), 5e6);
        vm.expectRevert(AgentPBMWallet.InvalidAgentSignature.selector);
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(otherToken), 5e6, sig);
    }

    function test_revert_tamperedAmount() public {
        bytes memory sig = _sig(INTENT_ID, address(usdc), 5e6);
        vm.expectRevert(AgentPBMWallet.InvalidAgentSignature.selector);
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), 6e6, sig);
    }

    function test_revert_highS_malleableSig() public {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(AGENT_PK, PbmDigest.spendDigest(address(wallet), INTENT_ID, address(usdc), 5e6));
        // The mirrored signature (n - s, flipped v) recovers to the same address but
        // must be rejected by the low-s bound — same policy as the EIP-3009 layer.
        bytes32 sMirror = bytes32(SECP256K1_N - uint256(s));
        uint8 vMirror = v == 27 ? 28 : 27;
        vm.expectRevert(AgentPBMWallet.InvalidAgentSignature.selector);
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), 5e6, abi.encodePacked(r, sMirror, vMirror));
    }

    function test_revert_badV() public {
        (, bytes32 r, bytes32 s) =
            vm.sign(AGENT_PK, PbmDigest.spendDigest(address(wallet), INTENT_ID, address(usdc), 5e6));
        vm.expectRevert(AgentPBMWallet.InvalidAgentSignature.selector);
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), 5e6, abi.encodePacked(r, s, uint8(29)));
    }

    function test_revert_sigLength64() public {
        (, bytes32 r, bytes32 s) =
            vm.sign(AGENT_PK, PbmDigest.spendDigest(address(wallet), INTENT_ID, address(usdc), 5e6));
        vm.expectRevert(AgentPBMWallet.InvalidAgentSignature.selector);
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), 5e6, abi.encodePacked(r, s));
    }

    // ---------------------------------------------------------------- authorizeSpend: expiry

    function test_authorizeSpend_atExactExpirySecond() public {
        (,, uint40 expiry,) = wallet.policy();
        vm.warp(expiry); // spending AT the expiry second is allowed (strict >)
        _spend(INTENT_ID, CATEGORY, 1e6);
        assertEq(wallet.spentToday(), 1e6);
    }

    function test_revert_policyExpired_oneSecondPast() public {
        (,, uint40 expiry,) = wallet.policy();
        vm.warp(uint256(expiry) + 1);
        bytes memory sig = _sig(INTENT_ID, address(usdc), 1e6);
        vm.expectRevert(AgentPBMWallet.PolicyExpired.selector);
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), 1e6, sig);
    }

    function test_revert_unsetPolicy_policyExpired() public {
        // A fresh wallet with no policy is safe-by-default: expiry 0 = expired.
        AgentPBMWallet fresh = new AgentPBMWallet(owner, agent, coreAddr, "");
        usdc.mint(address(fresh), 100e6);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(AGENT_PK, PbmDigest.spendDigest(address(fresh), INTENT_ID, address(usdc), 1e6));
        vm.expectRevert(AgentPBMWallet.PolicyExpired.selector);
        vm.prank(coreAddr);
        fresh.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), 1e6, abi.encodePacked(r, s, v));
    }

    // ---------------------------------------------------------------- policyUpdatedAt

    function test_policyUpdatedAt_stampsSetPolicyAndRevoke() public {
        AgentPBMWallet fresh = new AgentPBMWallet(owner, agent, coreAddr, "");
        // A wallet that has never been armed has no date to report, and 0 is how a client
        // tells that apart from one armed at the epoch.
        assertEq(fresh.policyUpdatedAt(), 0);

        vm.warp(1_800_000_000);
        vm.prank(owner);
        fresh.setPolicy(AgentPBMWallet.Policy({dailyCap: 1e6, perTxCap: 1e6, expiry: 1_900_000_000, categoryBitmap: 2}));
        assertEq(fresh.policyUpdatedAt(), 1_800_000_000);

        // Revoke is a policy change like any other. Dating a revoked wallet from the
        // setPolicy before it would put the wrong day on the one action a payer would
        // most want to prove they took.
        vm.warp(1_800_000_600);
        vm.prank(owner);
        fresh.revoke();
        assertEq(fresh.policyUpdatedAt(), 1_800_000_600);
    }

    function test_policyUpdatedAt_isNotMovedBySpending() public {
        uint40 armed = wallet.policyUpdatedAt();
        vm.warp(block.timestamp + 3600);
        bytes memory sig = _sig(INTENT_ID, address(usdc), 1e6);
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), 1e6, sig);
        // It dates the RULES, not the wallet's activity — a screen showing "rules updated"
        // beside a wallet that merely paid for coffee would be claiming a change that
        // nobody made.
        assertEq(wallet.policyUpdatedAt(), armed);
    }

    // ---------------------------------------------------------------- label

    function test_label_setAtConstructionAndRenamed() public {
        AgentPBMWallet named = new AgentPBMWallet(owner, agent, coreAddr, "Kopi Runner");
        assertEq(named.label(), "Kopi Runner");

        // 5-arg form: the emitter is pinned too, matching the factory suite's convention.
        vm.expectEmit(false, false, false, true, address(named));
        emit AgentPBMWallet.LabelSet("Lunch Runner");
        vm.prank(owner);
        named.setLabel("Lunch Runner");
        assertEq(named.label(), "Lunch Runner");
    }

    function test_label_doesNotMoveThePolicyDate() public {
        uint40 armed = wallet.policyUpdatedAt();
        assertGt(armed, 0, "the fixture wallet is armed");
        vm.warp(block.timestamp + 3600);
        vm.prank(owner);
        wallet.setLabel("Renamed an hour later");
        // The stamp dates the RULES, and every screen renders it as "rules updated". A
        // rename that bumped it would tell a payer their caps or categories moved when
        // only the nickname did.
        assertEq(wallet.policyUpdatedAt(), armed);
    }

    function test_label_emptyIsLegal() public {
        // Naming an agent must never be a precondition for arming one.
        assertEq(wallet.label(), "");
        vm.prank(owner);
        wallet.setLabel("");
        assertEq(wallet.label(), "");
    }

    function test_revert_label_tooLong() public {
        // 31 BYTES is the bound, so this is the first refused length, and the error
        // carries what was actually counted.
        string memory tooLong = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 32
        vm.expectRevert(abi.encodeWithSelector(AgentPBMWallet.LabelTooLong.selector, uint256(32)));
        vm.prank(owner);
        wallet.setLabel(tooLong);

        vm.prank(owner);
        wallet.setLabel("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); // 31 fits
        assertEq(bytes(wallet.label()).length, 31);
    }

    function test_revert_label_bytesNotCharacters() public {
        // Eight 4-byte emoji are 8 characters and 32 bytes. Any client-side counter that
        // counts codepoints — as the merchant profile limits deliberately do — would offer
        // a label this contract refuses.
        string memory eightEmoji = unicode"🍜🍜🍜🍜🍜🍜🍜🍜";
        assertEq(bytes(eightEmoji).length, 32);
        vm.expectRevert(abi.encodeWithSelector(AgentPBMWallet.LabelTooLong.selector, uint256(32)));
        vm.prank(owner);
        wallet.setLabel(eightEmoji);
    }

    function test_revert_label_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent));
        vm.prank(agent);
        wallet.setLabel("not yours");
    }

    function test_label_doesNotResetTheDailyCounter() public {
        bytes memory sig = _sig(INTENT_ID, address(usdc), 1e6);
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), 1e6, sig);
        assertEq(wallet.spentToday(), 1e6);
        // Unlike setPolicy, which deliberately zeroes it. A rename is not a fresh budget.
        vm.prank(owner);
        wallet.setLabel("Renamed mid-day");
        assertEq(wallet.spentToday(), 1e6);
    }

    // ---------------------------------------------------------------- authorizeSpend: category

    function test_revert_categoryNotAllowed_carriesCategoryId() public {
        bytes memory sig = _sig(INTENT_ID, address(usdc), 5e6);
        vm.expectRevert(abi.encodeWithSelector(AgentPBMWallet.CategoryNotAllowed.selector, uint16(2)));
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, uint16(2), address(usdc), 5e6, sig);
    }

    function test_category_bit0_allowed() public {
        vm.prank(owner);
        wallet.setPolicy(
            AgentPBMWallet.Policy({
                dailyCap: DAILY_CAP,
                perTxCap: PER_TX_CAP,
                expiry: uint40(block.timestamp + 30 days),
                categoryBitmap: 1 // bit 0 only
            })
        );
        _spend(INTENT_ID, 0, 1e6);
        assertEq(wallet.spentToday(), 1e6);
    }

    function test_category_bit255_allowed() public {
        vm.prank(owner);
        wallet.setPolicy(
            AgentPBMWallet.Policy({
                dailyCap: DAILY_CAP,
                perTxCap: PER_TX_CAP,
                expiry: uint40(block.timestamp + 30 days),
                categoryBitmap: 1 << 255
            })
        );
        _spend(INTENT_ID, 255, 1e6);
        assertEq(wallet.spentToday(), 1e6);
    }

    // ---------------------------------------------------------------- authorizeSpend: caps

    function test_perTxCap_exactlyEqual_passes() public {
        _spend(INTENT_ID, CATEGORY, PER_TX_CAP);
        assertEq(wallet.spentToday(), PER_TX_CAP);
    }

    function test_revert_perTxCapExceeded_paramValues() public {
        uint256 amount = uint256(PER_TX_CAP) + 1;
        bytes memory sig = _sig(INTENT_ID, address(usdc), amount);
        vm.expectRevert(abi.encodeWithSelector(AgentPBMWallet.PerTxCapExceeded.selector, amount, PER_TX_CAP));
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), amount, sig);
    }

    function test_dailyCap_cumulativeExactlyEqual_passes() public {
        _spend(keccak256("s1"), CATEGORY, PER_TX_CAP);
        _spend(keccak256("s2"), CATEGORY, PER_TX_CAP);
        _spend(keccak256("s3"), CATEGORY, 10e6); // lands exactly on the 50e6 cap
        assertEq(wallet.spentToday(), DAILY_CAP);
    }

    function test_revert_dailyCapExceeded_attemptedParam() public {
        _spend(keccak256("s1"), CATEGORY, PER_TX_CAP);
        _spend(keccak256("s2"), CATEGORY, PER_TX_CAP);

        uint256 amount = 10e6 + 1; // one unit past the cap
        bytes memory sig = _sig(INTENT_ID, address(usdc), amount);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPBMWallet.DailyCapExceeded.selector, uint256(DAILY_CAP) + 1, DAILY_CAP)
        );
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), amount, sig);
    }

    // ---------------------------------------------------------------- authorizeSpend: day window

    function test_dailyCap_resetsAtExactMidnight() public {
        _spend(keccak256("d1"), CATEGORY, PER_TX_CAP);
        _spend(keccak256("d2"), CATEGORY, PER_TX_CAP);
        _spend(keccak256("d3"), CATEGORY, 10e6);
        assertEq(wallet.spentToday(), DAILY_CAP);

        uint256 nextMidnight = (block.timestamp / 1 days + 1) * 1 days;
        vm.warp(nextMidnight); // the first second of the new UTC day
        assertEq(wallet.spentToday(), 0);
        _spend(keccak256("d4"), CATEGORY, PER_TX_CAP);
        assertEq(wallet.spentToday(), PER_TX_CAP);
    }

    function test_dailyCap_lastSecondOfDay_stillCounts() public {
        _spend(keccak256("d1"), CATEGORY, PER_TX_CAP);
        _spend(keccak256("d2"), CATEGORY, PER_TX_CAP);
        _spend(keccak256("d3"), CATEGORY, 10e6);

        uint256 lastSecond = (block.timestamp / 1 days + 1) * 1 days - 1;
        vm.warp(lastSecond); // still the same bucket — the cap must hold
        bytes memory sig = _sig(INTENT_ID, address(usdc), 1e6);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPBMWallet.DailyCapExceeded.selector, uint256(DAILY_CAP) + 1e6, DAILY_CAP)
        );
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), 1e6, sig);
    }

    function test_spentToday_readsZeroAfterDayRollover() public {
        _spend(INTENT_ID, CATEGORY, 5e6);
        assertEq(wallet.spentToday(), 5e6);
        vm.warp(block.timestamp + 1 days);
        assertEq(wallet.spentToday(), 0, "view is day-aware without a state write");
    }

    // ---------------------------------------------------------------- authorizeSpend: precedence

    /// @dev These names are read aloud on stage — which error fires for a compound
    ///      failure must be deterministic, so the check order itself is pinned.
    function test_errorPrecedence_sigBeforeExpiry() public {
        vm.prank(owner);
        wallet.revoke(); // policy now expired...
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(0xBAD, PbmDigest.spendDigest(address(wallet), INTENT_ID, address(usdc), 5e6));
        // ...but a bad signature still wins.
        vm.expectRevert(AgentPBMWallet.InvalidAgentSignature.selector);
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), 5e6, abi.encodePacked(r, s, v));
    }

    function test_errorPrecedence_expiryBeforeCategory() public {
        (,, uint40 expiry,) = wallet.policy();
        vm.warp(uint256(expiry) + 1);
        bytes memory sig = _sig(INTENT_ID, address(usdc), 5e6);
        // Expired policy + disallowed category: expiry fires first.
        vm.expectRevert(AgentPBMWallet.PolicyExpired.selector);
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, uint16(2), address(usdc), 5e6, sig);
    }

    function test_errorPrecedence_categoryBeforePerTx() public {
        uint256 amount = uint256(PER_TX_CAP) + 1;
        bytes memory sig = _sig(INTENT_ID, address(usdc), amount);
        // Disallowed category + over-cap amount: category fires first.
        vm.expectRevert(abi.encodeWithSelector(AgentPBMWallet.CategoryNotAllowed.selector, uint16(2)));
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, uint16(2), address(usdc), amount, sig);
    }

    function test_errorPrecedence_perTxBeforeDaily() public {
        uint256 amount = uint256(DAILY_CAP) + 10e6; // exceeds BOTH caps (60e6 > 20e6 per-tx, > 50e6 daily)
        bytes memory sig = _sig(INTENT_ID, address(usdc), amount);
        vm.expectRevert(abi.encodeWithSelector(AgentPBMWallet.PerTxCapExceeded.selector, amount, PER_TX_CAP));
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), amount, sig);
    }

    function test_errorPrecedence_dailyBeforeBalance() public {
        _spend(keccak256("p1"), CATEGORY, PER_TX_CAP);
        _spend(keccak256("p2"), CATEGORY, PER_TX_CAP); // 40e6 spent of the 50e6 cap
        uint256 drain = usdc.balanceOf(address(wallet)) - 5e6; // leave 5e6 < amount
        vm.prank(owner);
        wallet.withdraw(address(usdc), owner, drain);

        uint256 amount = 15e6; // within per-tx, busts the daily cap, exceeds the balance
        bytes memory sig = _sig(INTENT_ID, address(usdc), amount);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPBMWallet.DailyCapExceeded.selector, uint256(DAILY_CAP) + 5e6, DAILY_CAP)
        );
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), amount, sig);
    }

    // ---------------------------------------------------------------- authorizeSpend: edges

    function test_zeroAmount_spend_succeedsTransfersNothing() public {
        // Unreachable via the real core (createIntent rejects ZeroAmount) but pinned:
        // a zero spend passes every cap, moves nothing, and leaves the counter alone.
        _spend(INTENT_ID, CATEGORY, 0);
        assertEq(usdc.balanceOf(coreAddr), 0);
        assertEq(wallet.spentToday(), 0);
    }

    function test_revert_insufficientWalletBalance_paramValues() public {
        vm.prank(owner);
        wallet.withdraw(address(usdc), owner, 995e6); // leave 5e6 in the wallet

        bytes memory sig = _sig(INTENT_ID, address(usdc), 10e6);
        vm.expectRevert(abi.encodeWithSelector(AgentPBMWallet.InsufficientWalletBalance.selector, 5e6, 10e6));
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), 10e6, sig);
    }

    function test_directReplay_sameIntentId_walletPermits() public {
        // The wallet keeps no per-intent ledger BY DESIGN: GantryCore flips an intent to
        // Settled before calling here, so a real replay dies at the core with
        // IntentAlreadySettled (pinned in the integration suite). This test documents
        // the trust boundary — a pranked "core" CAN double-present the same intentId,
        // and both spends count against the caps.
        _spend(INTENT_ID, CATEGORY, 5e6);
        _spend(INTENT_ID, CATEGORY, 5e6);
        assertEq(wallet.spentToday(), 10e6);
    }

    // ---------------------------------------------------------------- cross-stack pin

    function test_crossStack_digestVector() public {
        // Mirrors packages/shared/src/agentPolicy.test.ts: same wallet address,
        // chainId, intentId, token, amount — and the digest is computed from the LIVE
        // contract's DOMAIN_SEPARATOR + typehash via deployCodeTo. If either side's
        // EIP-712 encoding drifts a byte, one of the two pins goes red instead of
        // every signature silently dying on-chain as InvalidAgentSignature.
        address vectorWallet = 0xDD4bbed78B64715288bf10fabB2b62c659299D3E;
        deployCodeTo("AgentPBMWallet.sol:AgentPBMWallet", abi.encode(owner, agent, coreAddr, ""), vectorWallet);
        vm.chainId(84532);

        bytes32 digest = PbmDigest.spendDigest(
            vectorWallet,
            0x1111111111111111111111111111111111111111111111111111111111111111,
            0x5F7F058F2B1572524d1E3E740656CfAd1Ab011F9,
            14_529_469
        );
        assertEq(digest, 0x1439a3cfe932d4b48486959d9c4faa8f9a9dd806a343f74bc96f44bfe2b29285);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_perTxBoundary(uint128 amount, uint128 cap) public {
        amount = uint128(bound(amount, 0, 1_000e6)); // wallet holds 1_000e6
        cap = uint128(bound(cap, 0, type(uint128).max));
        vm.prank(owner);
        wallet.setPolicy(
            AgentPBMWallet.Policy({
                dailyCap: type(uint128).max,
                perTxCap: cap,
                expiry: uint40(block.timestamp + 30 days),
                categoryBitmap: BITMAP
            })
        );

        bytes memory sig = _sig(INTENT_ID, address(usdc), amount);
        if (amount > cap) {
            vm.expectRevert(abi.encodeWithSelector(AgentPBMWallet.PerTxCapExceeded.selector, amount, cap));
        }
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), amount, sig);
    }

    function testFuzz_dailyAccumulation(uint128 a, uint128 b, uint128 cap) public {
        a = uint128(bound(a, 0, 500e6));
        b = uint128(bound(b, 0, 500e6));
        cap = uint128(bound(cap, a, 1_000_000e6)); // first spend always fits
        usdc.mint(address(wallet), 1_000_000e6);
        vm.prank(owner);
        wallet.setPolicy(
            AgentPBMWallet.Policy({
                dailyCap: cap,
                perTxCap: type(uint128).max,
                expiry: uint40(block.timestamp + 30 days),
                categoryBitmap: BITMAP
            })
        );

        _spend(keccak256("a"), CATEGORY, a);

        bytes memory sig = _sig(keccak256("b"), address(usdc), b);
        if (uint256(a) + b > cap) {
            vm.expectRevert(abi.encodeWithSelector(AgentPBMWallet.DailyCapExceeded.selector, uint256(a) + b, cap));
        }
        vm.prank(coreAddr);
        wallet.authorizeSpend(keccak256("b"), CATEGORY, address(usdc), b, sig);
    }

    function testFuzz_dayRollover(uint256 warpDelta) public {
        warpDelta = bound(warpDelta, 0, 3 days);
        uint256 dayBefore = block.timestamp / 1 days;

        // Exhaust the whole daily budget, then warp and try one more unit.
        vm.prank(owner);
        wallet.setPolicy(
            AgentPBMWallet.Policy({
                dailyCap: DAILY_CAP,
                perTxCap: DAILY_CAP,
                expiry: uint40(block.timestamp + 30 days),
                categoryBitmap: BITMAP
            })
        );
        _spend(keccak256("full"), CATEGORY, DAILY_CAP);

        vm.warp(block.timestamp + warpDelta);
        bool sameBucket = block.timestamp / 1 days == dayBefore;

        bytes memory sig = _sig(INTENT_ID, address(usdc), 1);
        if (sameBucket) {
            vm.expectRevert(
                abi.encodeWithSelector(AgentPBMWallet.DailyCapExceeded.selector, uint256(DAILY_CAP) + 1, DAILY_CAP)
            );
        }
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, CATEGORY, address(usdc), 1, sig);
    }

    function testFuzz_categoryBitmap(uint8 categoryId, uint256 bitmap) public {
        vm.prank(owner);
        wallet.setPolicy(
            AgentPBMWallet.Policy({
                dailyCap: DAILY_CAP,
                perTxCap: PER_TX_CAP,
                expiry: uint40(block.timestamp + 30 days),
                categoryBitmap: bitmap
            })
        );

        bool allowed = bitmap & (1 << categoryId) != 0;
        bytes memory sig = _sig(INTENT_ID, address(usdc), 1e6);
        if (!allowed) {
            vm.expectRevert(abi.encodeWithSelector(AgentPBMWallet.CategoryNotAllowed.selector, uint16(categoryId)));
        }
        vm.prank(coreAddr);
        wallet.authorizeSpend(INTENT_ID, uint16(categoryId), address(usdc), 1e6, sig);
    }
}
