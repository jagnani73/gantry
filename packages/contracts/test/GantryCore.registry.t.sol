// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GantryCore} from "../src/GantryCore.sol";
import {MockXSGD} from "../src/mocks/MockXSGD.sol";

contract GantryCoreRegistryTest is Test {
    GantryCore internal core;
    MockXSGD internal xsgd;

    address internal relayer;
    address internal payout;

    string internal constant HANDLE = "ah-hock-chicken-rice";
    uint16 internal constant CATEGORY_FOOD_BEVERAGE = 1;

    function setUp() public {
        relayer = makeAddr("relayer");
        payout = makeAddr("payout");
        xsgd = new MockXSGD();
        core = new GantryCore(IERC20(address(xsgd)), relayer);
    }

    function test_registerMerchant_happy() public {
        bytes32 expectedId = keccak256(bytes(HANDLE));

        vm.expectEmit(true, false, false, true, address(core));
        emit GantryCore.MerchantRegistered(expectedId, HANDLE, payout, CATEGORY_FOOD_BEVERAGE);

        bytes32 merchantId = core.registerMerchant(HANDLE, payout, CATEGORY_FOOD_BEVERAGE, "", "", "");

        assertEq(merchantId, expectedId);
        (address storedPayout, uint16 storedCategory, string memory storedHandle,,,) = core.merchants(merchantId);
        assertEq(storedPayout, payout);
        assertEq(storedCategory, CATEGORY_FOOD_BEVERAGE);
        assertEq(storedHandle, HANDLE);
    }

    function test_registerMerchant_isSingleCheapTx() public {
        // Measured with a REAL profile, because the backend requires all three fields
        // — so an empty-string registration is a path no user can take. Measuring
        // that one let the bound read as a guard while the actual onboarding call
        // (127,773 gas) already exceeded it. The ceiling is the cost of the three
        // strings, not a target: it is here to catch a change that makes onboarding
        // structurally expensive, not to police a few thousand gas.
        uint256 gasBefore = gasleft();
        core.registerMerchant(
            HANDLE,
            payout,
            CATEGORY_FOOD_BEVERAGE,
            "Ah Hock Chicken Rice",
            "Maxwell Food Centre",
            "Hainanese chicken rice, kopi and iced tea since 1987."
        );
        uint256 gasUsed = gasBefore - gasleft();
        assertLt(gasUsed, 200_000, "onboarding must stay a single affordable tx");
    }

    function test_revert_duplicateHandle() public {
        core.registerMerchant(HANDLE, payout, CATEGORY_FOOD_BEVERAGE, "", "", "");
        vm.expectRevert(abi.encodeWithSelector(GantryCore.HandleTaken.selector, keccak256(bytes(HANDLE))));
        core.registerMerchant(HANDLE, makeAddr("other"), CATEGORY_FOOD_BEVERAGE, "", "", "");
    }

    function test_revert_invalidHandles() public {
        string[5] memory bad = ["", "this-handle-is-thirty-three-bytes", "Ah-Hock", "-leading", "trailing-"];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(GantryCore.InvalidHandle.selector);
            core.registerMerchant(bad[i], payout, CATEGORY_FOOD_BEVERAGE, "", "", "");
        }
    }

    function test_registerMerchant_acceptsDigitsAndInnerHyphens() public {
        core.registerMerchant("stall-88", payout, CATEGORY_FOOD_BEVERAGE, "", "", "");
    }

    function test_revert_categoryGte256() public {
        vm.expectRevert(abi.encodeWithSelector(GantryCore.InvalidCategory.selector, uint16(256)));
        core.registerMerchant(HANDLE, payout, 256, "", "", "");
    }

    function test_revert_zeroPayout() public {
        vm.expectRevert(GantryCore.ZeroAddress.selector);
        core.registerMerchant(HANDLE, address(0), CATEGORY_FOOD_BEVERAGE, "", "", "");
    }

    function test_merchantIdOf_pureMatches() public view {
        assertEq(core.merchantIdOf(HANDLE), keccak256(bytes(HANDLE)));
    }

    function test_setRelayer_onlyOwner() public {
        address newRelayer = makeAddr("newRelayer");
        core.setRelayer(newRelayer);
        assertEq(core.relayer(), newRelayer);

        address rando = makeAddr("rando");
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, rando));
        core.setRelayer(relayer);
    }

    // ---------------------------------------------------------------- profile

    function test_registerMerchant_storesTheProfileOnChain() public {
        vm.expectEmit(true, false, false, true, address(core));
        emit GantryCore.MerchantProfileUpdated(
            keccak256(bytes(HANDLE)), "Ah Hock Chicken Rice", "Maxwell Food Centre", "Steamed or roasted, since 1978"
        );
        bytes32 merchantId = core.registerMerchant(
            HANDLE,
            payout,
            CATEGORY_FOOD_BEVERAGE,
            "Ah Hock Chicken Rice",
            "Maxwell Food Centre",
            "Steamed or roasted, since 1978"
        );

        (,,, string memory name, string memory location, string memory blurb) = core.merchants(merchantId);
        assertEq(name, "Ah Hock Chicken Rice");
        assertEq(location, "Maxwell Food Centre");
        assertEq(blurb, "Steamed or roasted, since 1978");
    }

    function test_setMerchantProfile_relayerRewritesDisplayFieldsOnly() public {
        bytes32 merchantId = core.registerMerchant(HANDLE, payout, CATEGORY_FOOD_BEVERAGE, "Old", "Old place", "Old");

        vm.expectEmit(true, false, false, true, address(core));
        emit GantryCore.MerchantProfileUpdated(merchantId, "New", "New place", "");
        vm.prank(relayer);
        core.setMerchantProfile(merchantId, "New", "New place", "");

        (address storedPayout, uint16 category, string memory handle, string memory name,, string memory blurb) =
            core.merchants(merchantId);
        assertEq(name, "New");
        assertEq(blurb, "", "an empty field clears rather than being ignored");
        // The three facts this relayer power must NOT be able to touch. Payout is the one
        // that matters: it rotates only through setMerchantPayout, gated on the payout
        // itself, so an operator who can rename a shop still cannot redirect its money.
        assertEq(storedPayout, payout);
        assertEq(category, CATEGORY_FOOD_BEVERAGE);
        assertEq(handle, HANDLE);
    }

    function test_revert_setMerchantProfile_notRelayer() public {
        bytes32 merchantId = core.registerMerchant(HANDLE, payout, CATEGORY_FOOD_BEVERAGE, "", "", "");
        // Not even the payout address, which CAN rotate where the money goes. The display
        // record is operator-owned by decision, and that has to be literally true.
        vm.prank(payout);
        vm.expectRevert(GantryCore.NotRelayer.selector);
        core.setMerchantProfile(merchantId, "Hijacked", "", "");
    }

    function test_revert_setMerchantProfile_unknownMerchant() public {
        bytes32 ghost = keccak256(bytes("no-such-shop"));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(GantryCore.MerchantNotFound.selector, ghost));
        core.setMerchantProfile(ghost, "", "", "");
    }

    function test_revert_profileTooLong_namesTheField() public {
        // 241 bytes: one past the ceiling, which is 4x the clients' 60-CODEPOINT limit so
        // that anything the shared validator accepts fits here. A form can only reach this
        // by bypassing that validator.
        string memory tooLong = _repeat("a", 241);
        vm.expectRevert(abi.encodeWithSelector(GantryCore.ProfileTooLong.selector, "displayName", uint256(241)));
        core.registerMerchant(HANDLE, payout, CATEGORY_FOOD_BEVERAGE, tooLong, "", "");

        vm.expectRevert(abi.encodeWithSelector(GantryCore.ProfileTooLong.selector, "location", uint256(321)));
        core.registerMerchant(HANDLE, payout, CATEGORY_FOOD_BEVERAGE, "", _repeat("a", 321), "");

        vm.expectRevert(abi.encodeWithSelector(GantryCore.ProfileTooLong.selector, "blurb", uint256(561)));
        core.registerMerchant(HANDLE, payout, CATEGORY_FOOD_BEVERAGE, "", "", _repeat("a", 561));
    }

    function test_profile_ceilingClearsTheClientLimitInBytes() public {
        // The heaviest string each client limit can produce: four-byte emoji at
        // 60/80/140 CODEPOINTS. All three must fit, or the form and the chain
        // disagree about a string the shared validator accepted — the drift the 4x
        // factor exists to prevent. Pinning only displayName left the other two
        // ceilings free to be tightened by hand.
        string memory name = _repeat(unicode"🍜", 60);
        string memory place = _repeat(unicode"🍜", 80);
        string memory line = _repeat(unicode"🍜", 140);
        assertEq(bytes(name).length, 240);
        assertEq(bytes(place).length, 320);
        assertEq(bytes(line).length, 560);
        core.registerMerchant(HANDLE, payout, CATEGORY_FOOD_BEVERAGE, name, place, line);
        (,,, string memory storedName, string memory storedPlace, string memory storedLine) =
            core.merchants(keccak256(bytes(HANDLE)));
        assertEq(storedName, name);
        assertEq(storedPlace, place);
        assertEq(storedLine, line);
    }

    function test_revert_setMerchantProfile_tooLong() public {
        // The bound is enforced on BOTH writers. Deleting the check inside
        // setMerchantProfile used to leave the whole suite green, while that is the
        // path an unauthenticated PATCH reaches on a demo host.
        bytes32 merchantId = core.registerMerchant(HANDLE, payout, CATEGORY_FOOD_BEVERAGE, "", "", "");
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(GantryCore.ProfileTooLong.selector, "blurb", uint256(561)));
        core.setMerchantProfile(merchantId, "", "", _repeat("a", 561));
    }

    function _repeat(string memory unit, uint256 times) internal pure returns (string memory out) {
        for (uint256 i; i < times; ++i) out = string.concat(out, unit);
    }

    function test_setMerchantPayout_rotatesPayout() public {
        bytes32 merchantId = core.registerMerchant(HANDLE, payout, CATEGORY_FOOD_BEVERAGE, "", "", "");
        address newPayout = makeAddr("newPayout");

        vm.expectEmit(true, false, false, true, address(core));
        emit GantryCore.MerchantPayoutUpdated(merchantId, newPayout);

        vm.prank(payout);
        core.setMerchantPayout(merchantId, newPayout);

        (address storedPayout,,,,,) = core.merchants(merchantId);
        assertEq(storedPayout, newPayout);
    }

    function test_revert_setMerchantPayout_notCurrentPayout() public {
        bytes32 merchantId = core.registerMerchant(HANDLE, payout, CATEGORY_FOOD_BEVERAGE, "", "", "");

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(abi.encodeWithSelector(GantryCore.NotMerchantPayout.selector, merchantId));
        core.setMerchantPayout(merchantId, makeAddr("attackerPayout"));
    }

    function test_revert_setMerchantPayout_zeroOrUnknown() public {
        bytes32 merchantId = core.registerMerchant(HANDLE, payout, CATEGORY_FOOD_BEVERAGE, "", "", "");

        vm.prank(payout);
        vm.expectRevert(GantryCore.ZeroAddress.selector);
        core.setMerchantPayout(merchantId, address(0));

        bytes32 ghost = keccak256("ghost");
        vm.expectRevert(abi.encodeWithSelector(GantryCore.MerchantNotFound.selector, ghost));
        core.setMerchantPayout(ghost, payout);
    }

    /// @dev Reference predicate mirrors the documented handle grammar; the fuzz compares
    ///      the contract's accept/reject against it byte for byte.
    function testFuzz_validateHandle_matchesGrammar(bytes calldata raw) public {
        bytes memory b = raw.length > 40 ? bytes(string(raw[:40])) : bytes(raw);
        bool expected = b.length >= 1 && b.length <= 32;
        if (expected && (b[0] == "-" || b[b.length - 1] == "-")) expected = false;
        if (expected) {
            for (uint256 i; i < b.length; ++i) {
                bytes1 c = b[i];
                if (!((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-")) {
                    expected = false;
                    break;
                }
            }
        }

        if (expected) {
            core.registerMerchant(string(b), payout, CATEGORY_FOOD_BEVERAGE, "", "", "");
        } else {
            vm.expectRevert(GantryCore.InvalidHandle.selector);
            core.registerMerchant(string(b), payout, CATEGORY_FOOD_BEVERAGE, "", "", "");
        }
    }

    function test_revert_constructorZeroAddresses() public {
        vm.expectRevert(GantryCore.ZeroAddress.selector);
        new GantryCore(IERC20(address(0)), relayer);
        vm.expectRevert(GantryCore.ZeroAddress.selector);
        new GantryCore(IERC20(address(xsgd)), address(0));
    }
}
