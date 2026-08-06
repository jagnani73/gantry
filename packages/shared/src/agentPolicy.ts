import type { Address, Hex } from "viem";

/**
 * EIP-712 layer for the AgentPBMWallet's SpendAuthorization — the agent session
 * key's signature that GantryCore.settleFromPBM hands to wallet.authorizeSpend.
 *
 * COORDINATION PIN: the Solidity side hashes
 *   keccak256("SpendAuthorization(bytes32 intentId,address token,uint256 amount)")
 * under domain {name:"AgentPBMWallet", version:"1", chainId, verifyingContract:wallet}.
 * The types below must stay byte-identical (field order included) or every
 * signature dies on-chain as InvalidAgentSignature — agentPolicy.test.ts pins a
 * cross-stack digest vector against the Foundry suite.
 */

export const PBM_WALLET_DOMAIN = { name: "AgentPBMWallet", version: "1" } as const;

export const SPEND_AUTHORIZATION_TYPES = {
  SpendAuthorization: [
    { name: "intentId", type: "bytes32" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
} as const;

export interface SpendAuthorizationParams {
  /** The AgentPBMWallet — the EIP-712 verifyingContract. */
  wallet: Address;
  chainId: number;
  /** Binds the signature to the pre-created Agent-door intent. */
  intentId: Hex;
  /** Must equal intent.tokenIn (= the accepts entry's asset). */
  token: Address;
  /** Must equal intent.amountIn (= the accepts entry's amount). */
  amount: bigint;
}

/** Ready for viem signTypedData / verifyTypedData. */
export function buildSpendAuthorization(params: SpendAuthorizationParams) {
  return {
    domain: {
      ...PBM_WALLET_DOMAIN,
      chainId: params.chainId,
      verifyingContract: params.wallet,
    },
    types: SPEND_AUTHORIZATION_TYPES,
    primaryType: "SpendAuthorization",
    message: {
      intentId: params.intentId,
      token: params.token,
      amount: params.amount,
    },
  } as const;
}

/**
 * JSON-safe form: uint256 crosses HTTP as a decimal string. The domain's
 * `verifyingContract` is absent when the backend mints the quote (the payer's
 * wallet is unknown at intent creation) — the client supplies it when reviving.
 */
export interface WireSpendAuthorization {
  domain: { name: string; version: string; chainId: number; verifyingContract?: Address };
  primaryType: "SpendAuthorization";
  message: { intentId: Hex; token: Address; amount: string };
}

export function toWireSpendAuthorization(
  params: Omit<SpendAuthorizationParams, "wallet"> & { wallet?: Address },
): WireSpendAuthorization {
  return {
    domain: {
      ...PBM_WALLET_DOMAIN,
      chainId: params.chainId,
      ...(params.wallet ? { verifyingContract: params.wallet } : {}),
    },
    primaryType: "SpendAuthorization",
    message: {
      intentId: params.intentId,
      token: params.token,
      amount: params.amount.toString(),
    },
  };
}

/** The string→bigint boundary for signing. `wallet` = the signer's own PBM wallet. */
export function reviveSpendAuthorization(wire: WireSpendAuthorization, wallet?: Address) {
  const verifyingContract = wallet ?? wire.domain.verifyingContract;
  if (!verifyingContract) {
    throw new Error("reviveSpendAuthorization: wallet address required (wire has no verifyingContract)");
  }
  return buildSpendAuthorization({
    wallet: verifyingContract,
    chainId: wire.domain.chainId,
    intentId: wire.message.intentId,
    token: wire.message.token,
    amount: BigInt(wire.message.amount),
  });
}
