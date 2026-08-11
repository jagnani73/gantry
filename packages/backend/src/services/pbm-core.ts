import { isAddress, verifyTypedData, type Address, type Hex } from "viem";
import { z } from "zod";
import {
  agentPbmWalletAbi,
  buildSpendAuthorization,
  checksummed,
  decodeGantryError,
  MAX_DENIAL_REASON_BYTES,
  rawRevertData,
  serializeArgs,
  type DenialEvent,
  type DenialListResponse,
  type GantryErrorName,
  type X402GantryPbmPayload,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "@gantry/shared";
import { ApiError } from "../errors";
import type { DenialRow } from "../db-core";
import { parseOrderPins, type VerifyFailure } from "./facilitator-core";

/**
 * Pure `gantry-pbm` verification logic — no config/chain imports so it
 * unit-tests without env (facilitator-core precedent). Chain-dependent checks
 * (wallet exists, agentSigner read, intent facts, balance) live in
 * services/facilitator.ts; the on-chain policy dimensions are deliberately NOT
 * pre-checked anywhere — the settle simulation's contract revert IS the
 * rejection beat.
 */

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x-prefixed address");

/** EOA session-key signatures only (65-byte), matching the wallet's splitter. */
export const GantryPbmPayloadSchema = z.object({
  pbmWallet: hexAddress,
  intentId: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected 32-byte hex intentId"),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "expected 65-byte hex signature"),
}) as z.ZodType<X402GantryPbmPayload>;

export type PbmValidation =
  | { ok: true; pbm: X402GantryPbmPayload; pins: { handle: string; xsgdAmount: bigint } }
  | { ok: false; failure: VerifyFailure };

/** Normalized intent facts for the pins match — one shape whether the intent
 * came from the SQLite cache row or the chain's getIntent struct, so the two
 * hand-mirrored loaders in facilitator.ts share ONE set of checks. */
export interface PbmIntentFacts {
  status: "pending" | "settled" | "cancelled" | "unknown";
  /** Numeric Door value (0 Human, 1 Agent). */
  door: number;
  /** Lowercased 0x hex. */
  merchantId: string;
  /** Lowercased 0x hex. */
  tokenIn: string;
  /** 6dp decimal string. */
  amountIn: string;
  xsgdAmount: bigint;
  /** Unix seconds (block time). */
  expiry: number;
}

/** A pbm intent must stay alive long enough for the single settle tx behind
 * the FIFO queue — fail a nearly-expired intent fast at verify instead of
 * burning a settle simulation on IntentExpired. */
export const PBM_EXPIRY_MARGIN_SECONDS = 30;

const AGENT_DOOR = 1;

/**
 * The security boundary the SpendAuthorization cannot cover: the signature
 * binds only (intentId, token, amount), so THESE checks are what stop a
 * signed cheap intent from settling a different merchant's or a pricier
 * order. Returns null when the intent matches the server-pinned facts.
 */
export function pbmIntentMismatch(
  facts: PbmIntentFacts,
  pins: { handle: string; xsgdAmount: bigint },
  requirements: X402PaymentRequirements,
  expectedMerchantId: string,
  now: number,
): VerifyFailure | null {
  const mismatch = (message: string): VerifyFailure => ({ reason: "intent_mismatch", message });

  if (facts.status === "unknown") {
    return { reason: "unknown_intent", message: "intent does not exist; POST /api/pbm/intent first" };
  }
  if (facts.status === "settled") {
    return { reason: "intent_already_settled", message: "intent already settled (replay?)" };
  }
  if (facts.status === "cancelled") {
    return { reason: "intent_cancelled", message: "intent was cancelled; create a fresh one" };
  }
  if (facts.expiry < now + PBM_EXPIRY_MARGIN_SECONDS) {
    return { reason: "intent_expired", message: "intent expired (or expires too soon); create a fresh one" };
  }
  if (facts.door !== AGENT_DOOR) return mismatch("intent is not an Agent-door intent");
  if (facts.merchantId !== expectedMerchantId.toLowerCase()) {
    return mismatch("intent merchant does not match the order");
  }
  if (facts.xsgdAmount !== pins.xsgdAmount) return mismatch("intent xsgdAmount does not match the order");
  if (facts.tokenIn !== requirements.asset.toLowerCase()) return mismatch("intent token does not match the offer");
  if (facts.amountIn !== requirements.amount) {
    return {
      reason: "quote_changed",
      message: `intent amountIn ${facts.amountIn} != offer ${requirements.amount}`,
    };
  }
  return null;
}

export interface PbmVerifyInputs {
  payload: X402PaymentPayload;
  requirements: X402PaymentRequirements;
  expectedNetwork: string;
  /** The pinned GantryCore — the pbm accepts entry's payTo (funds land there). */
  core: Address;
  /** Chain-read wallet.agentSigner() — passed in so the signature check stays pure. */
  agentSigner: Address;
  chainId: number;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function validatePbmPayment(inputs: PbmVerifyInputs): Promise<PbmValidation> {
  const { payload, requirements, expectedNetwork, core, agentSigner, chainId } = inputs;
  const fail = (reason: string, message: string): PbmValidation => ({
    ok: false,
    failure: { reason, message },
  });

  if (requirements.scheme !== "gantry-pbm" || payload.accepted.scheme !== "gantry-pbm") {
    return fail("unsupported_scheme", `pbm handler got scheme "${payload.accepted.scheme}"`);
  }
  if (requirements.network !== expectedNetwork || payload.accepted.network !== expectedNetwork) {
    return fail("unsupported_network", `facilitator settles on ${expectedNetwork} only`);
  }

  const parsed = GantryPbmPayloadSchema.safeParse(payload.payload);
  if (!parsed.success) {
    return fail("invalid_payload", "payload is not a {pbmWallet, intentId, signature} gantry-pbm payload");
  }
  const pbm = parsed.data;

  if (!eq(requirements.payTo, core)) {
    return fail("invalid_pay_to", "gantry-pbm requirements must pay GantryCore directly");
  }
  if (!/^\d+$/.test(requirements.amount) || BigInt(requirements.amount) <= 0n) {
    return fail("invalid_amount", `requirements.amount is not a positive decimal string: "${requirements.amount}"`);
  }

  // Order facts come ONLY from the server-pinned extra (the middleware hands
  // the handler its own rebuilt requirement) — same trust rule as the bridge.
  const pins = parseOrderPins(requirements.extra);
  if (!pins) {
    return fail(
      "invalid_requirements",
      "requirements.extra must pin handle and xsgdAmount (is this a gantry order requirement?)",
    );
  }

  const signed = await verifyTypedData({
    address: agentSigner,
    signature: pbm.signature,
    ...buildSpendAuthorization({
      wallet: pbm.pbmWallet,
      chainId,
      intentId: pbm.intentId,
      token: requirements.asset,
      amount: BigInt(requirements.amount),
    }),
  });
  if (!signed) {
    return fail(
      "invalid_signature",
      "signature does not recover the wallet's agentSigner over SpendAuthorization(intentId, token, amount)",
    );
  }

  return { ok: true, pbm, pins };
}

// ------------------------------------------------------------------- denials
//
// The other half of the pbm story: what to write down when the wallet says no,
// and how to read it back. Pure for the same reason the verification above is —
// this module never opens the database or the chain clients, so the rules below
// are testable without an environment. services/pbm.ts supplies the failure,
// routes/denials.ts supplies the store.

/**
 * The AgentPBMWallet errors that mean the POLICY refused the spend. Only these
 * may be recorded as a denial, because the payer's activity renders one as
 * "Declined on-chain" — a claim about what a contract did. A transport blip, an
 * RPC failure or an ambiguous settle outcome must never reach that feed, and
 * nor must a core-level revert (IntentExpired): that is a stale quote, not the
 * agent being refused.
 *
 * Typed against GantryErrorName so a contract-side rename breaks this build
 * rather than silently emptying the declined feed. Deliberately not every
 * wallet error — NotCore or ZeroAddress is a wiring bug, not a refusal.
 */
export const POLICY_DENIAL_ERRORS = [
  "CategoryNotAllowed",
  "PerTxCapExceeded",
  "DailyCapExceeded",
  "PolicyExpired",
  "InsufficientWalletBalance",
  "InvalidAgentSignature",
] as const satisfies readonly GantryErrorName[];

export const POLICY_DENIAL_NAMES: ReadonlySet<string> = new Set(POLICY_DENIAL_ERRORS);

export interface PolicyDenial {
  /** Verbatim, e.g. "CategoryNotAllowed" — it is read aloud on stage, and the
   * UI explains it alongside, never instead of. */
  errorName: string;
  /** Named revert args, JSON-safe. Absent when the revert carried none. */
  errorArgs?: Record<string, unknown>;
}

/**
 * A settle failure → the denial to record, or null when it is not one.
 *
 * Null is the honest answer for everything that is not a decoded wallet policy
 * error: only a revert proves the contract refused, and only these names prove
 * it was the policy. The caller pairs this with `isDefiniteFailure` — a revert
 * decodes the same way whether or not the tx was broadcast, and a denial that
 * might still mine is not a denial.
 */
export function policyDenialOf(err: unknown): PolicyDenial | null {
  const decoded = decodeGantryError(err);
  if (decoded.kind !== "custom" || !POLICY_DENIAL_NAMES.has(decoded.name)) return null;
  const errorArgs = namedErrorArgs(decoded.name, decoded.args);
  return { errorName: decoded.name, ...(errorArgs ? { errorArgs } : {}) };
}

/**
 * Positional revert args → `{ categoryId: 2 }`, using the wallet ABI's own
 * parameter names. Two conversions matter downstream: the uint256 pairs of
 * PerTxCapExceeded/DailyCapExceeded decode to BIGINTS, which `JSON.stringify`
 * throws on rather than rounds; and stringifying them yields raw 6dp units,
 * which is the amount convention every other field on the wire already uses —
 * so the UI renders them with the same formatter and never has to know they
 * came out of a revert.
 */
export function namedErrorArgs(
  name: string,
  args: readonly unknown[],
): Record<string, unknown> | undefined {
  if (args.length === 0) return undefined;
  const entry = agentPbmWalletAbi.find((item) => item.type === "error" && item.name === name);
  const inputs = entry?.type === "error" ? entry.inputs : [];
  return Object.fromEntries(
    args.map((value, i) => [inputs[i]?.name || `arg${i}`, serializeArgs(value)]),
  );
}

/** Stored row → wire event. Addresses are re-checksummed on the way out, for the
 * reason `checksummed` documents: the wallet on a declined receipt is the field
 * a payer would take to Basescan, and lowercase leaves nothing to check. */
export function denialEventOf(row: DenialRow): DenialEvent {
  const errorArgs = parseErrorArgs(row);
  return {
    intentId: row.intent_id as Hex,
    handle: row.handle,
    merchantId: row.merchant_id as Hex,
    wallet: checksummed(row.wallet),
    tokenIn: checksummed(row.token_in),
    amountIn: row.amount_in,
    xsgdAmount: row.xsgd_amount,
    errorName: row.error_name,
    ...(errorArgs !== undefined ? { errorArgs } : {}),
    cancelTxHash: row.cancel_tx as Hex | null,
    at: row.created_at,
  };
}

function parseErrorArgs(row: DenialRow): unknown {
  if (row.error_args === null) return undefined;
  try {
    return JSON.parse(row.error_args);
  } catch {
    // The error NAME is the load-bearing half and it is a column of its own —
    // dropping unreadable args beats 500ing the whole feed over them.
    console.warn(`denials: unreadable error_args on ${row.intent_id}, dropping them`);
    return undefined;
  }
}

/** The slice of the store this read needs, so a test can hand it a temp
 * database (or a spy) without standing up the singleton — settlements.ts
 * precedent, and the reason this module still imports no `../db`. */
export interface DenialReader {
  listDenials(wallet: string, limit?: number): DenialRow[];
  countDenials(wallet: string): number;
}

/** One page is the whole screen: a payer with more refusals than this has a
 * misconfigured agent, not a paging problem, and `total` still says so. */
export const DENIAL_PAGE_LIMIT = 50;

/**
 * `wallet` is REQUIRED, and a missing or malformed one is refused rather than
 * widened: a denial exposes an agent's spend policy — what it may buy and where
 * it hit its cap — so "no filter" must never mean "every payer's".
 */
export function parseDenialQuery(params: Record<string, unknown>): { wallet: Address } {
  const raw = params["wallet"];
  if (raw === undefined) {
    throw new ApiError(400, "MissingWallet", "wallet is required; GET /api/denials?wallet=0x…");
  }
  if (typeof raw !== "string") {
    // A repeated `?wallet=a&wallet=b` arrives as an array; picking a winner
    // would answer a question the caller did not ask.
    throw new ApiError(400, "InvalidWallet", "wallet must be given at most once");
  }
  // EIP-55 is deliberately not enforced — this is a read filter, so the worst a
  // wrong one does is return nothing (parsePayerFilter reasons the same way).
  if (!isAddress(raw.trim(), { strict: false })) {
    throw new ApiError(400, "InvalidWallet", `wallet is not an address: ${JSON.stringify(raw)}`);
  }
  return { wallet: raw.trim().toLowerCase() as Address };
}

export function listAgentDenials(
  store: DenialReader,
  params: Record<string, unknown>,
): DenialListResponse {
  const { wallet } = parseDenialQuery(params);
  return {
    rows: store.listDenials(wallet, DENIAL_PAGE_LIMIT).map(denialEventOf),
    total: store.countDenials(wallet),
  };
}

/**
 * The bytes that make a refusal recordable on-chain, or null.
 *
 * Pure, and here rather than beside its caller so it can be tested without an
 * environment — every defect this gate prevents is invisible in production. It
 * returns null for anything that is not a decoded WALLET POLICY error, because a
 * transport blip or a core-level revert recorded as a denial would put a
 * fabricated claim about the chain on a payer's screen.
 *
 * The bound is checked HERE, not left to the contract: `cancelIntentWithReason`
 * reverts past it, which would cost the cancellation as well as the record, so a
 * payload we cannot send must degrade to a plain cancel rather than break one.
 *
 * `onRefusal` reports WHY nothing will be recorded. Every exit is otherwise
 * silent by construction — a null return means the caller cannot tell a refused
 * payload from an error that was never a denial.
 */
export function denialReasonBytes(
  err: unknown,
  onRefusal: (why: string) => void,
): Hex | null {
  try {
    if (!policyDenialOf(err)) return null;
    const reason = rawRevertData(err);
    if (!reason) {
      onRefusal("decoded as a policy denial but carries no revert bytes");
      return null;
    }
    const bytes = (reason.length - 2) / 2;
    if (bytes === 0 || bytes > MAX_DENIAL_REASON_BYTES) {
      onRefusal(`revert payload is ${bytes} bytes, outside the core's ${MAX_DENIAL_REASON_BYTES}-byte bound`);
      return null;
    }
    return reason;
  } catch (err2) {
    onRefusal(`could not read the revert payload (${err2 instanceof Error ? err2.message : String(err2)})`);
    return null;
  }
}
