"use client";

import { useCallback } from "react";
import type { Address, Hex } from "viem";
import { useAccount, useSwitchChain, useWalletClient } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import {
  BASE_SEPOLIA_ADDRESSES,
  BASE_SEPOLIA_CHAIN_ID,
  buildProfileEdit,
  type MerchantProfile,
  type ProfileEditProof,
} from "@gantry/shared";

/**
 * Proving the shop is yours, so the backend will relay a rename.
 *
 * `setMerchantProfile` is `onlyRelayer`, so unlike a payout rotation this is not
 * a transaction the merchant sends — the relayer still sends it, and still pays
 * for it. What changes is that it will not send it without a signature from the
 * address the shop's payouts land in, which is the same identity the contract
 * itself checks on `setMerchantPayout`.
 *
 * Kept out of `payout-writes.ts` deliberately, even though both are authorised by
 * the same key. That file is about a TRANSACTION and carries the discipline a
 * transaction needs — simulate first, then `confirmTx` with its three
 * receipt hazards. None of it applies to a signature, and inheriting it would
 * suggest otherwise. The overlap is the six lines below that reach a wallet
 * client on the right chain.
 */

export interface ProfileWrites {
  /** The address in the browser wallet, or null. The screen compares it against
   * the shop's payout to decide whether the form does anything. */
  signer: Address | null;
  /**
   * Has the wallet finished answering? FALSE while wagmi reconnects.
   *
   * Without this, `signer === null` collapses "no wallet" and "not asked yet"
   * into one answer, and the screen renders the empty state for the reconnect —
   * so a merchant whose wallet IS connected is told to connect it, and the
   * locked rows then swap to inputs a moment later. On the one screen whose job
   * is to state which account signs, and with a layout shift. The payer app
   * carries the same rule for the same reason (`PayerIdentity.ready`): one is a
   * spinner, the other is an empty state.
   */
  ready: boolean;
  signProfileEdit(merchantId: Hex, profile: MerchantProfile): Promise<ProfileEditProof>;
}

export function useProfileWrites(): ProfileWrites {
  const { address, isConnected, status } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();

  const signProfileEdit = useCallback(
    async (merchantId: Hex, profile: MerchantProfile): Promise<ProfileEditProof> => {
      // A backstop, not the UI's guard: the form only offers Save once the
      // connected address matches the payout.
      if (!isConnected || !walletClient) {
        throw new Error(
          "Connect the wallet that receives this shop's payouts. Changes to a shop's details are signed by that address.",
        );
      }
      // Wallets refuse typed data whose domain names a chain other than the
      // active one, and the domain below is pinned to Base Sepolia — so this is
      // not the optional courtesy it looks like.
      if (walletClient.chain?.id !== baseSepolia.id) {
        await switchChainAsync({ chainId: baseSepolia.id });
      }

      /**
       * Stamped from the SIGNER's clock, and checked against the server's, which
       * is why the shared window carries a skew allowance. Seconds, not
       * milliseconds — it is signed as a uint256 and compared against a unix
       * second, so a millisecond value would be refused as issued far in the
       * future rather than as the mistake it is.
       */
      const issuedAt = Math.floor(Date.now() / 1000);
      const signature = await walletClient.signTypedData({
        ...buildProfileEdit({
          merchantId,
          profile,
          issuedAt,
          chainId: BASE_SEPOLIA_CHAIN_ID,
          gantryCore: BASE_SEPOLIA_ADDRESSES.gantryCore,
        }),
        // Never a bare address: an explicit string `account` is parsed as a
        // json-rpc account, which asks a node holding no keys to sign.
        account: walletClient.account,
      });

      return { signature, issuedAt };
    },
    [isConnected, switchChainAsync, walletClient],
  );

  return {
    signer: isConnected && address ? address : null,
    // `reconnecting` is the state a returning merchant lands in on every load;
    // `connecting` is an in-progress connect. Neither is an answer yet.
    ready: status !== "reconnecting" && status !== "connecting",
    signProfileEdit,
  };
}
