import type { Address, Hex } from "viem";
import type { GantryErrorName } from "./errors";
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

/**
 * Liveness, and only liveness: `ok` answers "is this process serving requests",
 * which is the one question the route can answer without asking anyone else. It
 * is deliberately not a verdict on the chain or the indexer — the deploy host
 * polls this path and restarts on a failure, so folding an RPC outage into it
 * would let a provider's bad minute wipe an instance whose SQLite cache (and
 * with it every off-chain merchant profile) lives on disk.
 *
 * The diagnosis lives in `indexer` instead, where a human or a monitor can read
 * it without anything acting on it.
 */
export interface HealthResponse {
  ok: boolean;
  /**
   * ISO-8601, and the one deliberate exception to this file's unix-seconds
   * convention: every other timestamp here is consumed by a screen, while this
   * one is read by whoever curls the endpoint. Not a precedent — `headAt` below
   * follows the convention.
   */
  timestamp: string;
  /** Process seconds. On a host that spins down when idle this is the first
   * thing worth knowing: a small number means you just paid a cold start. */
  uptime: number;
  /** Which affordances this host has open. The backend classifies itself from
   * NODE_ENV and FAILS OPEN on an unrecognised value, warning only at boot —
   * so on a long-lived deployment this field is the only way left to check that
   * `production` actually landed. */
  hostClass: "demo" | "public";
  chainId: number;
  relayer: Address;
  indexer: {
    cursor: number;
    head: number | null;
    lag: number | null;
    headAt: number | null;
  };
}

export interface MerchantResponse {
  handle: string;
  merchantId: Hex;
  payout: Address;
  categoryId: number;
  categoryName: string;
  /**
   * The off-chain display record. The chain stores only handle/payout/category,
   * so these are all optional: a merchant registered before the profile table
   * existed (or by a script) is a real merchant with no name. Fall back to the
   * handle rather than rendering an empty shop.
   */
  displayName?: string;
  location?: string;
  blurb?: string;
  /**
   * Unix seconds, read from the MerchantRegistered log. Absent when the log was
   * not found — the lookup window is bounded and the RPC can fail — and an
   * absent registration date must render as nothing, never as an estimate.
   */
  registeredAt?: number;
}

/**
 * Onboarding. `categoryId` is validated at the route against CATEGORIES — the
 * chain accepts any value < 256, but an unlisted one has no label and no bit in
 * the demo agent policy, so nothing here could ever spend at it.
 * Registration is permissionless on-chain; the backend relays it and pays the
 * gas, so this route carries faucet-level trust.
 *
 * The three profile fields are required because onboarding is the one moment
 * we have the merchant's attention: the handle is a URL, and every payer-facing
 * surface (receipt, merchant page, "places you've paid") shows the name.
 */
export interface RegisterMerchantRequest {
  handle: string;
  payout: Address;
  categoryId: number;
  displayName: string;
  location: string;
  blurb: string;
}

/**
 * PATCH /api/merchants/:handle — rewrites the off-chain display record only.
 * Nothing here touches the chain, so nothing here can misroute money.
 *
 * UNAUTHENTICATED, deliberately: there is no merchant login anywhere in Gantry,
 * so anyone with the URL can edit any shop's profile. That belongs on the
 * honest-labels list; do not paper over it with a login that checks nothing.
 */
export interface UpdateMerchantProfileRequest {
  displayName: string;
  location: string;
  blurb: string;
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
  /** 6dp XSGD units, e.g. "1500000" for S$1.50. */
  xsgdAmount: string;
  token: TokenId;
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
  /** XSGD 6dp out per 1e6 tokenIn units ("1000000" when tokenIn is MockXSGD). */
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
  /** 6dp XSGD units, e.g. "4500000" for S$4.50. */
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

/**
 * On-chain state of one AgentPBMWallet — every field is a live chain read, not
 * a cached row, which is why an agent screen can be trusted the moment it
 * renders. Amounts are the spend token's raw 6dp units; S$ figures are display
 * conversions via `rate` and must be labelled as such.
 */
export interface AgentSummary {
  wallet: Address;
  /** The human who owns the wallet and is the only address that may set or
   * revoke its policy. */
  owner: Address;
  /** The agent's session key — what signs SpendAuthorizations. */
  agentSigner: Address;
  dailyCap: string;
  perTxCap: string;
  /** Spend inside the CONTRACT's current day window, which rolls at
   * `block.timestamp / 1 days` — UTC days, i.e. 08:00 SGT, not local midnight.
   * Say "resets 08:00 SGT" wherever this is explained. */
  spentToday: string;
  /**
   * Unix seconds — the LAST second at which spends are allowed (the wallet
   * reverts PolicyExpired when `block.timestamp > expiry`); 0 = revoked.
   * A naturally lapsed policy (0 < expiry < now) denies every spend too while
   * `revoked` stays false, so never derive a status badge from `revoked`
   * alone — call `agentStatus`, which encodes exactly that comparison.
   */
  expiry: number;
  categoryBitmap: string;
  /** Decoded names for the set bits; an id the registry does not know renders
   * as `category_<id>` rather than disappearing. */
  categories: string[];
  /** The token whose balance is reported — what a top-up must TRANSFER (it is
   * real Circle USDC and cannot be minted). */
  token: TokenId;
  balance: string;
  /** XSGD 6dp out per 1e6 token units — the OWNER-SET display conversion. */
  rate: string;
  /** Derived: always `expiry === 0`. */
  revoked: boolean;
}

/**
 * GET /api/agents?owner=0x… — enumerated from the factory's
 * `WalletCreated(owner indexed, …)` logs, so the list is whatever the chain
 * says this payer owns; there is no server-side registry of agents.
 *
 * An agent's display name ("Kopi Runner") is deliberately NOT here. It is the
 * payer's private label for their own wallet, so the payer app keeps a
 * `wallet → name` map in localStorage and falls back to a short address — no
 * table, no endpoint, and no "who may rename this" question to answer.
 */
export interface AgentListResponse {
  agents: AgentSummary[];
  /**
   * Wallets that hold code but did not answer — a failed READ, never a fact
   * about the wallet. A lagging replica and an out-of-gas aggregate produce the
   * same per-entry failure as a non-wallet, so these are reported separately
   * rather than dropped from `agents`.
   *
   * A screen MUST announce them. "You have no agent" and "one of your agents
   * could not be read" lead to opposite actions, and the first one leads a payer
   * to create a SECOND wallet for the same signer — the state `demo-reset`
   * step 6b exists to detect. Absent when empty, so a client that ignores it
   * behaves exactly as before.
   */
  unreadable?: Address[];
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

/**
 * The gas leg's outcome — reported, not silent, because a payer whose gas
 * top-up quietly failed gets no error at all until an owner transaction dies in
 * their wallet with a message naming none of this.
 *
 * `txHash: null` with `funded: "0"` is a SUCCESS meaning "already held enough":
 * the leg is a top-up, not a grant, so sending nothing is the normal case.
 */
export interface FaucetGasResponse {
  txHash: Hex | null;
  /** Wei transferred. "0" means no transfer was needed. */
  funded: string;
  /** Present only when the leg refused; the USDC grant still succeeded. */
  error?: { name: string; message: string };
}

export interface FaucetResponse {
  txHash: Hex;
  /** 6dp USDC units transferred from the funder. */
  funded: string;
  /**
   * The gas leg runs first and its failure never fails this call — a payer who
   * cannot configure an agent has one unusable screen, where a payer who cannot
   * be funded cannot pay at all. Callers that only need gas should use
   * `POST /api/faucet/gas`, which never touches the scarce USDC ceiling.
   */
  gas?: FaucetGasResponse;
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
  /**
   * Position of the IntentSettled log within its block. Carried on the row —
   * not just in the SSE event id — for two reasons: `(txHash, logIndex)` is the
   * backend's primary key, so a client merging a paged history fetch with the
   * live stream dedupes on exactly the same key the server does; and any row can
   * mint its own cursor, so "load older" does not depend on having kept the
   * `nextCursor` that arrived with it.
   */
  logIndex: number;
  blockTime: number;
}

/**
 * A position in the settlement feed: `${blockNumber}:${logIndex}`, the same
 * encoding the SSE stream uses for its event id. Reused on purpose — a client
 * following the live stream and a client paging through history describe "where
 * I am" in one grammar instead of two that drift. Build and read it with
 * `encodeCursor` / `decodeCursor`; never split the string by hand.
 */
export type SettlementCursor = string;

/**
 * GET /api/settlements?handle=&payer=&before=&limit=
 *
 * `payer` takes a COMMA-SEPARATED list, and a row matches if EITHER its `payer`
 * or its `agentPayer` is in it. That is what lets the payer app ask for "me and
 * my agents" in one query: a PBM payment's on-chain payer is the wallet, not
 * the human, so filtering on the human's address alone would hide exactly the
 * rows the agents screen exists to show. Parse it with `parsePayerFilter`.
 *
 * `before` is a cursor — omit it for the newest page. `limit` defaults to 50
 * and caps at 200. Rows are newest-first, ordered by (blockNumber, logIndex);
 * two settlements in one block therefore have a stable order.
 */
export interface SettlementListResponse {
  rows: SettlementEvent[];
  /** Pass as `before` to fetch the next page; null once the last page was
   * returned, which is the only signal that stops an infinite scroll. */
  nextCursor: SettlementCursor | null;
  /** Rows matching the filter ignoring pagination — the sidebar nav counts. */
  total: number;
}

/**
 * An agent payment the PBM wallet REFUSED. The policy revert is caught in
 * simulation, before anything is broadcast (services/pbm.ts), so there is no
 * settlement, no transfer, and no on-chain event: this record is the only trace
 * the attempt ever happened.
 */
export interface DenialEvent {
  intentId: Hex;
  handle: string;
  merchantId: Hex;
  /** The PBM wallet that refused — the payer's own agent, not the merchant. */
  wallet: Address;
  tokenIn: Address;
  amountIn: string;
  xsgdAmount: string;
  /**
   * The Gantry custom error name, VERBATIM: "CategoryNotAllowed",
   * "DailyCapExceeded", … The UI may explain it alongside; never instead of —
   * it is read aloud on stage, so the contract's own spelling is the payload.
   *
   * Widened with the open arm for the same reason `DecodedGantryError.name` is:
   * every producer reaches this field through a viem decode (`decodeErrorResult`
   * handles selectors outside our ABI too) or through the denials table's TEXT
   * column, so a closed union would be a claim the wire cannot keep. The named
   * arm still carries the ABI's spelling into editors and readers, and the
   * enforced list is `POLICY_DENIAL_ERRORS` in services/pbm-core.ts — it is
   * `satisfies readonly GantryErrorName[]`, so a contract-side rename breaks the
   * build there rather than quietly emptying this feed.
   */
  errorName: GantryErrorName | (string & {});
  /**
   * Decoded revert args, e.g. `{ categoryId: 2 }`. Absent when the revert
   * carried none (PolicyExpired, InvalidAgentSignature). Any amount in here is
   * a 6dp decimal STRING like every other amount on the wire — the uint256 args
   * of PerTxCapExceeded/DailyCapExceeded decode to bigints, which
   * `JSON.stringify` throws on rather than rounds, so they must be converted
   * where the revert is decoded.
   */
  errorArgs?: unknown;
  /**
   * The tx that CANCELLED the intent. There is no reverted tx to link to — the
   * revert never left the simulator — so a receipt reads "Cancelled · 0x…" from
   * this field and nothing else. null when the cancel itself failed, in which
   * case render no hash at all rather than inventing one.
   */
  cancelTxHash: Hex | null;
  /** Unix seconds. There is no block to take a timestamp from — nothing was
   * mined — so this is the server's clock when the denial was recorded. */
  at: number;
}

/**
 * GET /api/denials?wallet= — payer-side only. A merchant never sees denials:
 * nothing was ever presented to them, and an agent stopped by its own policy is
 * the payer's guardrail working, not a failed sale.
 */
export interface DenialListResponse {
  rows: DenialEvent[];
  total: number;
}

