import type { Address, Hex } from "viem";
import type { TokenId } from "./tokens";
import type { WireDoor } from "./door";
import type { WireTypedData } from "./eip3009";

/**
 * Wire types for every backend route. Convention: ALL token/XSGD amounts are
 * decimal strings of 6dp integer units; timestamps are unix seconds (number).
 */

export interface HealthResponse {
  ok: boolean;
  chainId: number;
  block: number;
  relayer: Address;
  indexerCursor: number;
}

export interface MerchantResponse {
  handle: string;
  merchantId: Hex;
  payout: Address;
  categoryId: number;
  categoryName: string;
  displayName?: string;
  location?: string;
}

export interface CreateIntentRequest {
  handle: string;
  /** 6dp XSGD units, e.g. "6500000" for S$6.50. */
  xsgdAmount: string;
  token?: TokenId;
  door?: WireDoor;
}

/**
 * Field names deliberately map onto the x402 accepts[] vocabulary:
 * intentId = nonce, tokenIn = asset, amountIn = amount, payTo = GantryCore.
 * M2's 402 handler is a thin re-encoding of this response.
 */
export interface IntentResponse {
  intentId: Hex;
  merchantId: Hex;
  handle: string;
  tokenIn: Address;
  tokenSymbol: TokenId;
  amountIn: string;
  xsgdAmount: string;
  /** XSGD 6dp out per 1e6 tokenIn units ("1000000" when tokenIn is XSGD). */
  rate: string;
  expiry: number;
  door: WireDoor;
  payTo: Address;
  validAfter: string;
  validBefore: number;
  typedData: WireTypedData;
  txHash: Hex;
}

export type IntentWireStatus = "pending" | "settled" | "cancelled" | "expired" | "unknown";

export interface IntentStatusResponse {
  intentId: Hex;
  status: IntentWireStatus;
  handle?: string;
  merchantId?: Hex;
  tokenIn?: Address;
  amountIn?: string;
  xsgdAmount?: string;
  expiry?: number;
  door?: WireDoor;
  settleTxHash?: Hex;
}

export interface SettleRequest {
  payer: Address;
  /** 65-byte compact hex signature from signTypedData. */
  signature: Hex;
  /**
   * Signed authorization window; must byte-match what was signed. Optional —
   * the backend falls back to its stored quote. Explicit values keep the
   * settle path stateless for M2's facilitator.
   */
  validAfter?: string;
  validBefore?: number;
}

export interface SettleResponse {
  status: "settled";
  intentId: Hex;
  txHash: Hex;
  blockNumber: number;
  /** Gross swap output; merchant nets xsgdOut − feeXsgd. */
  xsgdOut: string;
  feeXsgd: string;
}

export interface ApiErrorBody {
  error: {
    /** Custom error name ("IntentExpired"), "StringRevert", or "InternalError". */
    name: string;
    args?: unknown;
    message: string;
  };
}

export interface FaucetRequest {
  address: Address;
}

export interface FaucetResponse {
  txHash: Hex;
  minted: string;
}

/** SSE `settlement` event payload (event id = `${blockNumber}:${logIndex}`). */
export interface SettlementEvent {
  intentId: Hex;
  merchantId: Hex;
  handle: string;
  payer: Address;
  tokenIn: Address;
  tokenSymbol: TokenId | null;
  amountIn: string;
  xsgdOut: string;
  feeXsgd: string;
  door: WireDoor;
  txHash: Hex;
  blockNumber: number;
  blockTime: number;
}

/** SSE `intent` event payload (pending ghost rows / cancellations). */
export interface IntentLifecycleEvent {
  type: "created" | "cancelled";
  intentId: Hex;
  merchantId: Hex;
  handle: string | null;
  xsgdAmount: string;
  door: WireDoor;
}
