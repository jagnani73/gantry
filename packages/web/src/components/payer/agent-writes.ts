"use client";

import { useCallback } from "react";
import {
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import {
  BASE_SEPOLIA_ADDRESSES,
  agentPbmWalletAbi,
  agentPbmWalletFactoryAbi,
} from "@gantry/shared";
import { api } from "@/lib/api";
import { getDemoAccount } from "@/lib/demo-account";
import { usePayerIdentity } from "./identity";

/**
 * Agent configuration is signed by the PAYER, not by a server.
 *
 * `setPolicy` and `revoke` are `onlyOwner` and the owner is the payer, so there
 * is no endpoint that can write a policy — that is the point of the screen. It
 * also means these are the only transactions in Gantry the payer pays gas for,
 * which is why the faucet grants a little ETH alongside its USDC: configuring an
 * agent is an owner action, and owners funding their own wallet is normal.
 * Paying a merchant still costs the payer nothing.
 */

export interface WalletPolicy {
  dailyCap: bigint;
  perTxCap: bigint;
  /**
   * Absolute unix seconds, and a `number` because the field is `uint40`.
   * Derive it from CHAIN time — a laptop minutes fast would arm a policy that is
   * already dead by the contract's clock.
   */
  expiry: number;
  categoryBitmap: bigint;
}

/**
 * Below this the payer cannot land a single transaction, so the faucet is asked
 * first. Well under the faucet's own 0.002 ETH target: the point is to catch an
 * empty key, not to keep topping one up that is fine.
 */
const GAS_FLOOR = 300_000_000_000_000n; // 0.0003 ETH

export interface AgentWrites {
  /** Creates the wallet through the permissionless factory and returns the
   * address the `WalletCreated` log reports — never the simulated one. */
  createWallet(agentSigner: Address): Promise<{ wallet: Address; txHash: Hex }>;
  setPolicy(wallet: Address, policy: WalletPolicy): Promise<Hex>;
  revoke(wallet: Address): Promise<Hex>;
  /** Chain seconds. `setPolicy` expiries and status badges both need it. */
  chainNow(): Promise<number>;
}

export function useAgentWrites(): AgentWrites {
  const { address, demo, connected } = usePayerIdentity();
  const publicClient = usePublicClient();
  const { data: connectedWalletClient } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();

  /** The signer for owner actions, plus the gas the payer needs to send them. */
  const signer = useCallback(async (): Promise<{ client: WalletClient; account: Address }> => {
    if (!publicClient) throw new Error("no RPC client — reload the page");
    if (demo) {
      const account = getDemoAccount();
      if ((await publicClient.getBalance({ address: account.address })) < GAS_FLOOR) {
        // The faucet's gas leg never throws and tops up only when low, so this
        // is safe to call again; what it must not do is run on every write.
        await api.faucet(account.address);
      }
      return {
        client: createWalletClient({ account, chain: baseSepolia, transport: http() }),
        account: account.address,
      };
    }
    if (!connected || !connectedWalletClient || !address) {
      throw new Error("connect a wallet to configure an agent");
    }
    if (connectedWalletClient.chain?.id !== baseSepolia.id) {
      await switchChainAsync({ chainId: baseSepolia.id });
    }
    return { client: connectedWalletClient, account: address };
  }, [address, demo, connected, connectedWalletClient, publicClient, switchChainAsync]);

  const chainNow = useCallback(async (): Promise<number> => {
    if (!publicClient) throw new Error("no RPC client — reload the page");
    const block = await publicClient.getBlock();
    return Number(block.timestamp);
  }, [publicClient]);

  const createWallet = useCallback(
    async (agentSigner: Address) => {
      const { client, account } = await signer();
      if (!publicClient) throw new Error("no RPC client — reload the page");
      // Simulate first, as everything that sends in this repo does: a policy or
      // wiring revert surfaces as a decodable error instead of a burnt tx.
      await publicClient.simulateContract({
        address: BASE_SEPOLIA_ADDRESSES.agentPbmFactory,
        abi: agentPbmWalletFactoryAbi,
        functionName: "createWallet",
        args: [agentSigner],
        account,
      });
      const txHash = await client.writeContract({
        address: BASE_SEPOLIA_ADDRESSES.agentPbmFactory,
        abi: agentPbmWalletFactoryAbi,
        functionName: "createWallet",
        args: [agentSigner],
        account,
        chain: baseSepolia,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      // The address comes from the log, not from the simulation: the factory
      // deploys with CREATE, so the simulated address is only correct while the
      // factory's nonce has not moved — and it moves whenever anyone else
      // creates a wallet in the same block.
      const [created] = parseEventLogs({
        abi: agentPbmWalletFactoryAbi,
        eventName: "WalletCreated",
        logs: receipt.logs,
      });
      if (!created) throw new Error("wallet was created but the WalletCreated log was not found");
      // The deploy is mined, but the next call can land on a replica that has
      // not seen the block — and the caller's next move is to simulate
      // `setPolicy` against this address, which fails outright if the code is
      // not there yet. Same lag the payer page waits out before signing.
      for (let i = 0; (await publicClient.getCode({ address: created.args.wallet })) === undefined; i++) {
        if (i >= 8) throw new Error("the wallet was created but is not visible yet — try again");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return { wallet: created.args.wallet, txHash };
    },
    [publicClient, signer],
  );

  const setPolicy = useCallback(
    async (wallet: Address, policy: WalletPolicy) => {
      const { client, account } = await signer();
      if (!publicClient) throw new Error("no RPC client — reload the page");
      const args = [policy] as const;
      await publicClient.simulateContract({
        address: wallet,
        abi: agentPbmWalletAbi,
        functionName: "setPolicy",
        args,
        account,
      });
      const txHash = await client.writeContract({
        address: wallet,
        abi: agentPbmWalletAbi,
        functionName: "setPolicy",
        args,
        account,
        chain: baseSepolia,
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      return txHash;
    },
    [publicClient, signer],
  );

  const revoke = useCallback(
    async (wallet: Address) => {
      const { client, account } = await signer();
      if (!publicClient) throw new Error("no RPC client — reload the page");
      await publicClient.simulateContract({
        address: wallet,
        abi: agentPbmWalletAbi,
        functionName: "revoke",
        account,
      });
      const txHash = await client.writeContract({
        address: wallet,
        abi: agentPbmWalletAbi,
        functionName: "revoke",
        account,
        chain: baseSepolia,
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      return txHash;
    },
    [publicClient, signer],
  );

  return { createWallet, setPolicy, revoke, chainNow };
}
