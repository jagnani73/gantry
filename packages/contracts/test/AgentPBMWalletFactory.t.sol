// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentPBMWallet} from "../src/AgentPBMWallet.sol";
import {AgentPBMWalletFactory} from "../src/AgentPBMWalletFactory.sol";

contract AgentPBMWalletFactoryTest is Test {
    AgentPBMWalletFactory internal factory;
    address internal coreAddr;
    address internal alice;
    address internal agent;

    function setUp() public {
        coreAddr = makeAddr("core");
        alice = makeAddr("alice");
        agent = makeAddr("agent");
        factory = new AgentPBMWalletFactory(coreAddr);
    }

    function test_createWallet_configuresOwnerSignerCore() public {
        // Contract nonces start at 1, so the first CREATE address is predictable —
        // letting us assert the exact WalletCreated payload up front.
        address predicted = vm.computeCreateAddress(address(factory), 1);

        vm.expectEmit(true, true, true, true, address(factory));
        emit AgentPBMWalletFactory.WalletCreated(alice, agent, predicted);
        vm.prank(alice);
        address wallet = factory.createWallet(agent, "");

        assertEq(wallet, predicted);
        assertEq(AgentPBMWallet(wallet).owner(), alice);
        assertEq(AgentPBMWallet(wallet).agentSigner(), agent);
        assertEq(AgentPBMWallet(wallet).CORE(), coreAddr);
    }

    function test_createWallet_indexesByOwner() public {
        vm.prank(alice);
        address w1 = factory.createWallet(agent, "");
        vm.prank(alice);
        address w2 = factory.createWallet(makeAddr("agent2"), "");

        address[] memory wallets = factory.walletsOf(alice);
        assertEq(wallets.length, 2);
        assertEq(wallets[0], w1);
        assertEq(wallets[1], w2);
        assertEq(factory.walletsOf(makeAddr("stranger")).length, 0);
    }

    function test_factoryWallet_ownerIsCallerNotFactory() public {
        vm.prank(alice);
        AgentPBMWallet wallet = AgentPBMWallet(factory.createWallet(agent, ""));
        // Ownable must wire to the human caller — a factory-owned wallet would strand
        // every owner operation behind a contract with no admin surface.
        assertEq(wallet.owner(), alice);
        assertTrue(wallet.owner() != address(factory));
    }

    function test_createWallet_carriesTheLabelThroughToTheWallet() public {
        // The path a real payer takes. Every other test here passes "", so without this
        // the factory could drop the argument on the floor and the suite would agree.
        // Naming at creation is the whole reason the factory takes a label at all: it
        // keeps creating-and-arming at two transactions instead of three.
        vm.prank(alice);
        AgentPBMWallet wallet = AgentPBMWallet(factory.createWallet(agent, "Kopi Runner"));
        assertEq(wallet.label(), "Kopi Runner");
        // A label is not a policy: the wallet is still unarmed and cannot spend.
        assertEq(wallet.policyUpdatedAt(), 0);
    }

    function test_revert_createWallet_labelTooLong() public {
        // Bubbles from the constructor exactly as ZeroAddress does, so the factory needs
        // no length check of its own — and a client that skipped its byte pre-check would
        // burn the deploy rather than get a quiet truncation.
        vm.expectRevert(abi.encodeWithSelector(AgentPBMWallet.LabelTooLong.selector, uint256(32)));
        vm.prank(alice);
        factory.createWallet(agent, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); // 32
    }

    function test_revert_createWallet_zeroAgentSigner() public {
        // Bubbles from the wallet constructor — same ZeroAddress selector either way.
        vm.expectRevert(AgentPBMWallet.ZeroAddress.selector);
        vm.prank(alice);
        factory.createWallet(address(0), "");
    }

    function test_revert_constructor_zeroCore() public {
        vm.expectRevert(AgentPBMWalletFactory.ZeroAddress.selector);
        new AgentPBMWalletFactory(address(0));
    }
}
