import type { Address, Hex } from "viem";
import type { TokenId } from "./tokens";
import type { WireDoor } from "./door";
import type { WireTypedData } from "./eip3009";
import type { WireSpendAuthorization } from "./agentPolicy";

/**
 * Wire types for every backend route. Conventions: ALL token/XSGD amounts are
 * decimal strings of 6dp integer units; display timestamps (expiry, blockTime)
 * are unix seconds as numbers; authorization-window fields (validAfter,
 * validBefore) are uint256 decimal STRINGS — they must byte-match the signed
 * typed-data message, and x402's `exact` scheme carries them as strings.
 */

export interface HealthResponse {
  ok: boolean;
  chainId: number;
  block: number;
  relayer: Address;
  indexerCursor: number;
  /** Whether POST /api/merchants is accepting registrations here — off on
   * public hosts, so the web app hides onboarding rather than offering a form
   * that can only 403. */
  onboardingEnabled: boolean;
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

/**
 * Onboarding. `categoryId` is narrowed to the ids in CATEGORIES — the chain
 * accepts any value < 256, but an unlisted one has no label and no policy bit.
 * Registration is permissionless on-chain; the backend relays it and pays the
 * gas, so this route carries faucet-level trust.
 */
export interface RegisterMerchantRequest {
  handle: string;
  payout: Address;
  categoryId: number;
}

export interface RegisterMerchantResponse extends MerchantResponse {
  /**
   * The relayer tx that registered this merchant, or null when the handle was
   * already on-chain pointing at this exact payout — a retry after a lost
   * response or a receipt timeout, where nothing new was sent.
   */
  txHash: Hex | null;
  /** True in that no-op case. The merchant owns the handle either way. */
  alreadyRegistered: boolean;
}

/** The door is NOT client-suppliable — it is derived from the route (QR/payer
 * page ⇒ Human; the facilitator bridge and POST /api/pbm/intent ⇒ Agent). */
export interface CreateIntentRequest {
  handle: string;
  /** 6dp XSGD units, e.g. "6500000" for S$6.50. */
  xsgdAmount: string;
  token?: TokenId;
}

/**
 * Field names deliberately map onto x402 vocabulary (tokenIn = asset,
 * amountIn = amount, payTo = GantryCore, intentId = the authorization nonce)
 * because the QR flow signs the same EIP-3009 authorization an x402 `exact`
 * payment carries. The agent door prices its 402 independently — `exact` via
 * the facilitator bridge (payTo = relayer), `gantry-pbm` paying GantryCore
 * directly. `typedData.message` is authoritative for the authorization
 * window; the top-level copies exist for convenience.
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
  validBefore: string;
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
  validBefore?: string;
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

/** POST /api/pbm/intent — pre-creates the Agent-door intent the gantry-pbm
 * client must sign over (the SpendAuthorization binds the intentId). */
export interface CreatePbmIntentRequest {
  handle: string;
  /** 6dp XSGD units, e.g. "19500000" for S$19.50. */
  xsgdAmount: string;
}

export interface PbmIntentResponse {
  intentId: Hex;
  merchantId: Hex;
  handle: string;
  tokenIn: Address;
  tokenSymbol: TokenId;
  /** What the wallet will pay — the client MUST check it equals the accepts
   * entry's amount before signing. */
  amountIn: string;
  xsgdAmount: string;
  expiry: number;
  /** Wallet-agnostic (no verifyingContract) — the client revives with its own
   * PBM wallet address before signing. */
  typedData: WireSpendAuthorization;
  txHash: Hex;
}

/** GET /api/policy — on-chain AgentPBMWallet state for the dashboard panel and
 * the agent's check_my_policy tool. Amounts are raw 6dp token units; the UI
 * converts to S$ via `rate`. */
export interface PolicyResponse {
  wallet: Address;
  agentSigner: Address;
  dailyCap: string;
  perTxCap: string;
  spentToday: string;
  /** Unix seconds; 0 = revoked/unset (expired-by-default). Note a NATURALLY
   * lapsed policy (0 < expiry < now) also denies every spend (PolicyExpired)
   * while `revoked` stays false — consumers rendering "active" should compare
   * expiry against the clock too. */
  expiry: number;
  categoryBitmap: string;
  /** Decoded category names for bits set in the bitmap. */
  categories: string[];
  /** The order token whose balance is reported — what a top-up must mint. */
  token: TokenId;
  /** Wallet's balance of the order token. */
  balance: string;
  /** XSGD 6dp out per 1e6 token units — the display conversion factor. */
  rate: string;
  /** Derived: always `expiry === 0`. */
  revoked: boolean;
}

export interface RevokePolicyResponse {
  txHash: Hex;
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
  /** On-chain payer from IntentSettled — the relayer for bridged x402 rows. */
  payer: Address;
  /** The x402 payer when the facilitator bridged a vanilla exact payment
   * (funds hopped agent → relayer → core; on-chain payer is the relayer). */
  agentPayer?: Address;
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

