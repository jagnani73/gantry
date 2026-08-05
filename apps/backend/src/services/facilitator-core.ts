import { verifyTypedData, type Address } from "viem";
import { z } from "zod";
import {
  buildTransferAuthorization,
  isValidHandle,
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

/** An authorization must outlive collect + createIntent + settle (three
 * relayer txs behind the FIFO queue) or the bridge risks signing work it
 * cannot finish. */
export const VERIFY_MARGIN_SECONDS = 30;

/** The single deterministic pricing channel: the order URL. Both the 402's
 * DynamicPrice and the bridge's settle re-derive {handle, sgd} from it, which
 * is what makes challenge, retry and settlement agree on the quote. */
export function parseOrderResource(url: string): { handle: string; sgd: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const match = /^\/api\/order\/([^/]+)$/.exec(parsed.pathname);
  if (!match) return null;
  const handle = decodeURIComponent(match[1]!);
  const sgd = parsed.searchParams.get("sgd");
  if (!isValidHandle(handle) || !sgd) return null;
  return { handle, sgd };
}

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x-prefixed address");
const decimalString = z.string().regex(/^\d+$/, "expected decimal string");

/** EOA signatures only (65-byte): ERC-6492 smart-wallet payers are out of
 * scope for the bridge and fail here as invalid_payload. */
export const ExactEvmPayloadSchema: z.ZodType<X402ExactEvmPayload> = z.object({
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
