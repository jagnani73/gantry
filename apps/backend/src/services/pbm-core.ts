import { verifyTypedData, type Address } from "viem";
import { z } from "zod";
import {
  buildSpendAuthorization,
  type X402GantryPbmPayload,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "@gantry/shared";
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
