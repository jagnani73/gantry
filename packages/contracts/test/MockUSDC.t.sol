// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {EIP3009} from "../src/mocks/EIP3009.sol";
import {Eip3009Digest} from "./helpers/Eip3009Digest.sol";

contract MockUSDCTest is Test {
    MockUSDC internal usdc;

    uint256 internal constant PAYER_PK = 0xA11CE;
    address internal payer;
    address internal recipient;
    address internal relayer;

    uint256 internal constant VALUE = 100e6;
    bytes32 internal constant NONCE = keccak256("nonce-1");

    function setUp() public {
        vm.warp(1_755_000_000);
        usdc = new MockUSDC();
        payer = vm.addr(PAYER_PK);
        recipient = makeAddr("recipient");
        relayer = makeAddr("relayer");
        usdc.mint(payer, 1_000e6);
    }

    function _signTransfer(uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 digest =
            Eip3009Digest.transferDigest(address(usdc), payer, recipient, VALUE, validAfter, validBefore, nonce);
        (v, r, s) = vm.sign(PAYER_PK, digest);
    }

    function test_transferWithAuthorization_happy() public {
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(0, block.timestamp + 1 hours, NONCE);

        vm.expectEmit(true, true, false, false, address(usdc));
        emit EIP3009.AuthorizationUsed(payer, NONCE);

        vm.prank(relayer);
        usdc.transferWithAuthorization(payer, recipient, VALUE, 0, block.timestamp + 1 hours, NONCE, v, r, s);

        assertEq(usdc.balanceOf(recipient), VALUE);
        assertEq(usdc.balanceOf(payer), 900e6);
        assertTrue(usdc.authorizationState(payer, NONCE));
    }

    function test_transferWithAuthorization_bytesOverload() public {
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(0, validBefore, NONCE);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.prank(relayer);
        usdc.transferWithAuthorization(payer, recipient, VALUE, 0, validBefore, NONCE, signature);

        assertEq(usdc.balanceOf(recipient), VALUE);
    }

    function test_revert_replayedAuthorization() public {
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(0, validBefore, NONCE);
        usdc.transferWithAuthorization(payer, recipient, VALUE, 0, validBefore, NONCE, v, r, s);

        vm.expectRevert(abi.encodeWithSelector(EIP3009.AuthorizationAlreadyUsed.selector, payer, NONCE));
        usdc.transferWithAuthorization(payer, recipient, VALUE, 0, validBefore, NONCE, v, r, s);
    }

    function test_revert_notYetValid() public {
        uint256 validAfter = block.timestamp + 100;
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(validAfter, validBefore, NONCE);

        vm.expectRevert(EIP3009.AuthorizationNotYetValid.selector);
        usdc.transferWithAuthorization(payer, recipient, VALUE, validAfter, validBefore, NONCE, v, r, s);
    }

    function test_revert_expiredAuthorization() public {
        uint256 validBefore = block.timestamp - 1;
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(0, validBefore, NONCE);

        vm.expectRevert(EIP3009.AuthorizationExpired.selector);
        usdc.transferWithAuthorization(payer, recipient, VALUE, 0, validBefore, NONCE, v, r, s);
    }

    function test_revert_wrongSigner() public {
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 digest = Eip3009Digest.transferDigest(address(usdc), payer, recipient, VALUE, 0, validBefore, NONCE);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, digest);

        vm.expectRevert(EIP3009.InvalidSignature.selector);
        usdc.transferWithAuthorization(payer, recipient, VALUE, 0, validBefore, NONCE, v, r, s);
    }

    function test_revert_tamperedAmount() public {
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signTransfer(0, validBefore, NONCE);

        vm.expectRevert(EIP3009.InvalidSignature.selector);
        usdc.transferWithAuthorization(payer, recipient, VALUE + 1, 0, validBefore, NONCE, v, r, s);
    }

    function test_receiveWithAuthorization_requiresPayeeCaller() public {
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 digest = Eip3009Digest.receiveDigest(address(usdc), payer, recipient, VALUE, 0, validBefore, NONCE);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_PK, digest);

        vm.prank(relayer);
        vm.expectRevert(EIP3009.CallerMustBePayee.selector);
        usdc.receiveWithAuthorization(payer, recipient, VALUE, 0, validBefore, NONCE, v, r, s);

        vm.prank(recipient);
        usdc.receiveWithAuthorization(payer, recipient, VALUE, 0, validBefore, NONCE, v, r, s);
        assertEq(usdc.balanceOf(recipient), VALUE);
    }

    function test_cancelAuthorization_blocksLaterUse() public {
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 tv, bytes32 tr, bytes32 ts) = _signTransfer(0, validBefore, NONCE);

        bytes32 cancelDigest = Eip3009Digest.cancelDigest(address(usdc), payer, NONCE);
        (uint8 cv, bytes32 cr, bytes32 cs) = vm.sign(PAYER_PK, cancelDigest);

        vm.expectEmit(true, true, false, false, address(usdc));
        emit EIP3009.AuthorizationCanceled(payer, NONCE);
        usdc.cancelAuthorization(payer, NONCE, cv, cr, cs);

        vm.expectRevert(abi.encodeWithSelector(EIP3009.AuthorizationAlreadyUsed.selector, payer, NONCE));
        usdc.transferWithAuthorization(payer, recipient, VALUE, 0, validBefore, NONCE, tv, tr, ts);
    }

    function test_domainSeparator_matchesNameVersionChainId() public view {
        bytes32 expected = Eip3009Digest.domainSeparator("Mock USDC", "1", block.chainid, address(usdc));
        assertEq(usdc.DOMAIN_SEPARATOR(), expected);
    }

    function test_decimals_sixLikeRealUsdc() public view {
        assertEq(usdc.decimals(), 6);
    }
}
