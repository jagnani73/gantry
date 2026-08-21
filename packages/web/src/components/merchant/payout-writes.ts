"use client";

import { useCallback } from "react";
import { getAddress, type Address, type Hex } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { BASE_SEPOLIA_ADDRESSES, gantryCoreAbi } from "@gantry/shared";
import { confirmTx } from "@/lib/confirm-tx";

/**
 * Rotating where a merchant gets paid — the one back-office action the chain
 * authenticates for us.
 *
 * `setMerchantPayout` is gated on `msg.sender == merchant.payout`, so this is
 * signed by the merchant's own wallet and the relayer cannot help. That is worth
 * stating plainly, because the back-office is still open to READ: anyone with the
 * URL can see a shop's takings, and the reason they cannot redirect its money is
 * this line in the contract rather than anything in front of it.
 *
 * The other write on this surface, a profile edit, is authenticated by the same
 * address but not by the contract — `setMerchantProfile` is `onlyRelayer`, so the
 * check lives in the backend. See `profile-writes.ts`.
 *
 * Deliberately NOT routed through the backend. A relayer-paid rotation would
 * have to be gated by something the backend knows, and it knows nothing about
 * who a merchant is — which is exactly how a payout address ends up rotatable by
 * a stranger with a handle.
 *
 * There is also no demo-key branch here, unlike the payer's writes. The demo key
 * is a PAYER account; it is not any shop's payout, so offering it would produce
 * a guaranteed `NotMerchantPayout` revert dressed up as a working button.
 */

export interface PayoutWrites {
  /** The address currently in the browser wallet, or null. Screens compare it
   * against the merchant's payout to decide whether the form can do anything. */
  signer: Address | null;
  setMerchantPayout(merchantId: Hex, newPayout: Address): Promise<Hex>;
}

export function usePayoutWrites(): PayoutWrites {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();

  const setMerchantPayout = useCallback(
    async (merchantId: Hex, newPayout: Address) => {
      if (!publicClient) {
        throw new Error(
          "no RPC client for Base Sepolia: this build is misconfigured, and reloading will not change it",
        );
      }
      // A backstop, not the UI's guard: the screen only offers the form once the
      // connected address matches the payout, so reaching this means a caller
      // skipped that check rather than a merchant clicking too early.
      if (!isConnected || !walletClient) {
        throw new Error(
          "Connect the wallet that currently receives this shop's payouts. The contract only accepts this change from that address.",
        );
      }
      if (walletClient.chain?.id !== baseSepolia.id) {
        await switchChainAsync({ chainId: baseSepolia.id });
      }
      // `getAddress` here is belt-and-braces, and worth being honest about what
      // it is NOT doing. It cannot affect what the contract stores — an EVM
      // address is 20 raw bytes with no casing — and the caller has already put
      // this value through `normalizePayout`, which returns a checksummed
      // `Address`. Note `normalizePayout` deliberately ACCEPTS all-lowercase
      // input (there is no checksum to verify in that form), so "already strict
      // EIP-55" would be the wrong reason to trust it; what it does guarantee is
      // that a MIXED-case address matched its checksum before it got here.
      const args = [merchantId, getAddress(newPayout)] as const;
      // Simulate first. This is the write where it earns the most: the caller
      // may not be the payout at all (`NotMerchantPayout`), and finding that out
      // from a revert costs the merchant gas to learn something a read knew.
      //
      // `walletClient.account`, never a bare address — an explicit string
      // `account` is parsed as a JSON-RPC account, which asks a node that holds
      // no keys to sign.
      await publicClient.simulateContract({
        address: BASE_SEPOLIA_ADDRESSES.gantryCore,
        abi: gantryCoreAbi,
        functionName: "setMerchantPayout",
        args,
        account: walletClient.account,
      });
      const txHash = await walletClient.writeContract({
        address: BASE_SEPOLIA_ADDRESSES.gantryCore,
        abi: gantryCoreAbi,
        functionName: "setMerchantPayout",
        args,
        account: walletClient.account,
        chain: baseSepolia,
      });
      // A merchant's own wallet, so no shared-key caveat: a replacement here
      // really is something they did themselves.
      await confirmTx(publicClient, "setMerchantPayout", txHash);
      return txHash;
    },
    [isConnected, publicClient, switchChainAsync, walletClient],
  );

  return { signer: isConnected && address ? address : null, setMerchantPayout };
}
