import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { parseSignature, verifyTypedData, type Address, type Hex } from "viem";
import { z } from "zod";
import {
  buildTransferAuthorization,
  isValidHandle,
  parseSgd,
  type DecodedGantryError,
  type Eip712TokenDomain,
  type X402ExactEvmPayload,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "@gantry/shared";

/**
 * Pure x402 verification logic — no config/chain imports so it unit-tests
 * without env (db-core.ts precedent). Chain-dependent checks (asset known,
 * authorization unused, balance) live in services/facilitator.ts.
 */

/** The agent's authorization is consumed on-chain by the COLLECT tx, which
 * lands only after verify + createIntent (two relayer txs behind the FIFO
 * queue) — this margin keeps it valid until then. The settle tx uses the
 * relayer's own authorization, bounded by the intent's validBefore instead. */
export const VERIFY_MARGIN_SECONDS = 30;

/** Parses the order route's request URL into {handle, sgd}. Used by the 402's
 * DynamicPrice (server-observed URL) — the resulting facts are then PINNED
 * into requirements.extra (see parseOrderPins), which is what the bridge
 * trusts at settle time; the client-echoed resource.url is never load-bearing.
 * Rejects non-positive sgd so `?sgd=0` fails here, not inside the quote.
 *
 * TWO paths, one quote. `/api/order/:handle` is the agent-only endpoint;
 * `/pay/:handle` is the dual-door pay link, which serves a browser a redirect
 * and a machine this same challenge. They must parse identically or the two
 * doors would price the same order differently — which is the one thing the
 * link exists to disprove. Widening this is safe precisely because the URL is
 * not load-bearing at settle: the pin is. */
export function parseOrderResource(url: string): { handle: string; sgd: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const match = /^\/(?:api\/order|pay)\/([^/]+)$/.exec(parsed.pathname);
  if (!match) return null;
  const handle = decodeURIComponent(match[1]!);
  const sgd = parsed.searchParams.get("sgd");
  if (!isValidHandle(handle) || !sgd) return null;
  try {
    if (parseSgd(sgd) <= 0n) return null;
  } catch {
    return null;
  }
  return { handle, sgd };
}

/** Server-pinned order facts from requirements.extra. Trustworthy at settle:
 * the middleware hands the bridge its OWN rebuilt requirement (subset-matched
 * against the client echo), so a client cannot redirect the order to another
 * merchant by tampering with what it echoes. Vanilla clients ignore the extra
 * keys beyond the EIP-712 name/version. */
/**
 * The order facts, authenticated.
 *
 * `handle` and `xsgdAmount` decide WHICH MERCHANT gets paid, and on the vanilla
 * `exact` scheme nothing else does: the custodial hop sets `payTo` to the
 * relayer for every order, so the payer's EIP-3009 signature commits to an
 * amount and a collector and says nothing about the shop. That is safe while
 * the requirements come from `paymentRequired.accepts` — the SDK matches the
 * client's echo against the server-built entry — but `POST /facilitator/settle`
 * is a spec-shaped public route that validates only the SHAPE of the
 * requirements it is handed. Without a pin, a caller holding an unused
 * authorization made out to the relayer can name any merchant they like.
 *
 * A keyed digest is the smallest thing that closes it: the server can tell its
 * own quote from a caller's, and a caller cannot mint one.
 *
 * The secret is per-process and random — deliberately NOT configuration. It
 * never leaves the box, there is nothing to rotate or leak, and one host serves
 * both halves of any single order. A restart between challenge and settle
 * invalidates in-flight challenges, which is correct rather than unfortunate:
 * the quote they carry is one this process never made.
 */
const ORDER_PIN_SECRET = randomBytes(32);

export interface OrderPinFacts {
  handle: string;
  xsgdAmount: string;
  asset: string;
  amount: string;
}

export function orderPin(facts: OrderPinFacts): string {
  // Length-prefixed, so no combination of field values can be re-partitioned
  // into a different order that digests the same.
  const message = [facts.handle, facts.xsgdAmount, facts.asset.toLowerCase(), facts.amount]
    .map((part) => `${part.length}:${part}`)
    .join("|");
  return createHmac("sha256", ORDER_PIN_SECRET).update(message).digest("hex");
}

/**
 * Read the order facts back out, and refuse them unless this process pinned
 * them. Returns null on any failure, which every caller already treats as
 * `invalid_requirements`.
 */
export function parseOrderPins(
  extra: Record<string, unknown>,
  requirements: { asset: string; amount: string },
): { handle: string; xsgdAmount: bigint } | null {
  const handle = extra["handle"];
  const xsgd = extra["xsgdAmount"];
  const pin = extra["pin"];
  if (typeof handle !== "string" || !isValidHandle(handle)) return null;
  if (typeof xsgd !== "string" || !/^\d+$/.test(xsgd)) return null;
  if (typeof pin !== "string") return null;
  const xsgdAmount = BigInt(xsgd);
  if (xsgdAmount <= 0n) return null;

  const expected = orderPin({
    handle,
    xsgdAmount: xsgd,
    asset: requirements.asset,
    amount: requirements.amount,
  });
  // Constant-time, and length-guarded because timingSafeEqual throws on a
  // length mismatch rather than returning false.
  const given = Buffer.from(pin, "utf8");
  const want = Buffer.from(expected, "utf8");
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  return { handle, xsgdAmount };
}

/** 65-byte signature → contract-ready (v, r, s); some signers emit the final
 * byte as yParity (0/1) rather than v (27/28) — normalize either way. */
export function splitSignature65(signature: Hex): { v: number; r: Hex; s: Hex } {
  const { v, r, s, yParity } = parseSignature(signature);
  return { v: Number(v ?? BigInt(yParity + 27)), r, s };
}

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x-prefixed address");
const decimalString = z.string().regex(/^\d+$/, "expected decimal string");

/** EOA signatures only (65-byte): ERC-6492 smart-wallet payers are out of
 * scope for the bridge and fail here as invalid_payload. */
export const ExactEvmPayloadSchema = z.object({
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "expected 65-byte hex signature"),
  authorization: z.object({
    from: hexAddress,
    to: hexAddress,
    value: decimalString,
    validAfter: decimalString,
    validBefore: decimalString,
    nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected 32-byte hex nonce"),
  }),
}) as z.ZodType<X402ExactEvmPayload>;

export interface VerifyFailure {
  reason: string;
  message: string;
}

export type ExactValidation =
  | { ok: true; exact: X402ExactEvmPayload }
  | { ok: false; failure: VerifyFailure };

export interface VerifyInputs {
  payload: X402PaymentPayload;
  requirements: X402PaymentRequirements;
  /** Unix seconds. */
  now: number;
  relayer: Address;
  expectedNetwork: string;
  /** OUR pinned token domain — never the client-supplied extra. A payload
   * signed against a tampered domain simply fails signature recovery. */
  domain: Eip712TokenDomain;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function validateExactPayment(inputs: VerifyInputs): Promise<ExactValidation> {
  const { payload, requirements, now, relayer, expectedNetwork, domain } = inputs;
  const fail = (reason: string, message: string): ExactValidation => ({
    ok: false,
    failure: { reason, message },
  });

  if (requirements.scheme !== "exact" || payload.accepted.scheme !== "exact") {
    return fail("unsupported_scheme", `facilitator only settles "exact", got "${payload.accepted.scheme}"`);
  }
  if (requirements.network !== expectedNetwork || payload.accepted.network !== expectedNetwork) {
    return fail("unsupported_network", `facilitator settles on ${expectedNetwork} only`);
  }

  const parsed = ExactEvmPayloadSchema.safeParse(payload.payload);
  if (!parsed.success) {
    return fail("invalid_payload", "payload is not a 65-byte-signature eip3009 exact payload");
  }
  const { authorization, signature } = parsed.data;

  if (!eq(requirements.payTo, relayer) || !eq(authorization.to, requirements.payTo)) {
    return fail("invalid_pay_to", "authorization must pay the facilitator's collector address");
  }
  if (!/^\d+$/.test(requirements.amount)) {
    return fail("invalid_amount", `requirements.amount is not a decimal string: "${requirements.amount}"`);
  }
  const value = BigInt(authorization.value);
  if (value <= 0n || value !== BigInt(requirements.amount)) {
    return fail("invalid_amount", `authorization value ${authorization.value} != required ${requirements.amount}`);
  }
  if (BigInt(authorization.validAfter) > BigInt(now)) {
    return fail("authorization_not_yet_valid", "authorization validAfter is in the future");
  }
  if (BigInt(authorization.validBefore) < BigInt(now + VERIFY_MARGIN_SECONDS)) {
    return fail("authorization_expired", `authorization must stay valid ${VERIFY_MARGIN_SECONDS}s past verification`);
  }

  const typedData = buildTransferAuthorization({
    domain,
    from: authorization.from,
    to: authorization.to,
    value,
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce,
  });
  const signed = await verifyTypedData({ address: authorization.from, signature, ...typedData });
  if (!signed) {
    return fail("invalid_signature", "signature does not recover authorization.from over the pinned token domain");
  }

  return { ok: true, exact: parsed.data };
}

/** x402 invalidReason/errorReason from a decoded settlement revert: Gantry
 * custom error names pass through verbatim (the demo's rejection vocabulary),
 * Circle's string reverts get the one mapping that matters, the rest collapse
 * to settlement_failed with the detail in the message field. */
export function reasonForGantryError(decoded: DecodedGantryError): string {
  if (decoded.kind === "custom") return decoded.name;
  if (decoded.kind === "string" && /used or canceled/i.test(decoded.reason)) {
    return "authorization_already_used";
  }
  return "settlement_failed";
}
