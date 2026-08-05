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

        bytes32 merchantId = core.registerMerchant(HANDLE, payout, CATEGORY_FOOD_BEVERAGE);

        assertEq(merchantId, expectedId);
        (address storedPayout, uint16 storedCategory, string memory storedHandle) = core.merchants(merchantId);
        assertEq(storedPayout, payout);
        assertEq(storedCategory, CATEGORY_FOOD_BEVERAGE);
        assertEq(storedHandle, HANDLE);
    }

    function test_registerMerchant_isSingleCheapTx() public {
        uint256 gasBefore = gasleft();
        core.registerMerchant(HANDLE, payout, CATEGORY_FOOD_BEVERAGE);
        uint256 gasUsed = gasBefore - gasleft();
        assertLt(gasUsed, 120_000, "onboarding must stay a single cheap tx");
    }

    function test_revert_duplicateHandle() public {
        core.registerMerchant(HANDLE, payout, CATEGORY_FOOD_BEVERAGE);
        vm.expectRevert(abi.encodeWithSelector(GantryCore.HandleTaken.selector, keccak256(bytes(HANDLE))));
        core.registerMerchant(HANDLE, makeAddr("other"), CATEGORY_FOOD_BEVERAGE);
    }

    function test_revert_invalidHandles() public {
        string[5] memory bad = ["", "this-handle-is-thirty-three-bytes", "Ah-Hock", "-leading", "trailing-"];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(GantryCore.InvalidHandle.selector);
            core.registerMerchant(bad[i], payout, CATEGORY_FOOD_BEVERAGE);
        }
    }

    function test_registerMerchant_acceptsDigitsAndInnerHyphens() public {
        core.registerMerchant("stall-88", payout, CATEGORY_FOOD_BEVERAGE);
    }

    function test_revert_categoryGte256() public {
        vm.expectRevert(abi.encodeWithSelector(GantryCore.InvalidCategory.selector, uint16(256)));
        core.registerMerchant(HANDLE, payout, 256);
    }

    function test_revert_zeroPayout() public {
        vm.expectRevert(GantryCore.ZeroAddress.selector);
        core.registerMerchant(HANDLE, address(0), CATEGORY_FOOD_BEVERAGE);
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

    function test_setMerchantPayout_rotatesPayout() public {
        bytes32 merchantId = core.registerMerchant(HANDLE, payout, CATEGORY_FOOD_BEVERAGE);
        address newPayout = makeAddr("newPayout");

        vm.expectEmit(true, false, false, true, address(core));
        emit GantryCore.MerchantPayoutUpdated(merchantId, newPayout);

        vm.prank(payout);
        core.setMerchantPayout(merchantId, newPayout);

        (address storedPayout,,) = core.merchants(merchantId);
        assertEq(storedPayout, newPayout);
    }

    function test_revert_setMerchantPayout_notCurrentPayout() public {
        bytes32 merchantId = core.registerMerchant(HANDLE, payout, CATEGORY_FOOD_BEVERAGE);

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(abi.encodeWithSelector(GantryCore.NotMerchantPayout.selector, merchantId));
        core.setMerchantPayout(merchantId, makeAddr("attackerPayout"));
    }

    function test_revert_setMerchantPayout_zeroOrUnknown() public {
        bytes32 merchantId = core.registerMerchant(HANDLE, payout, CATEGORY_FOOD_BEVERAGE);

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
            core.registerMerchant(string(b), payout, CATEGORY_FOOD_BEVERAGE);
        } else {
            vm.expectRevert(GantryCore.InvalidHandle.selector);
            core.registerMerchant(string(b), payout, CATEGORY_FOOD_BEVERAGE);
        }
    }

    function test_revert_constructorZeroAddresses() public {
        vm.expectRevert(GantryCore.ZeroAddress.selector);
        new GantryCore(IERC20(address(0)), relayer);
        vm.expectRevert(GantryCore.ZeroAddress.selector);
        new GantryCore(IERC20(address(xsgd)), address(0));
    }
}
