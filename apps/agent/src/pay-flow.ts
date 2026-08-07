import { privateKeyToAccount } from "viem/accounts";
import {
  BASESCAN_BASE_URL,
  DEMO_MERCHANTS,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  parseSgd,
  reviveSpendAuthorization,
  type MerchantResponse,
  type PbmIntentResponse,
  type PolicyResponse,
  type X402PaymentRequirements,
} from "@gantry/shared";
import { env, requireSigningEnv } from "./env";

/**
 * The deterministic gantry-pbm client — bare fetch + the owned wire codec,
 * deliberately NOT @x402/fetch (whose client scheme registry is exact-only;
 * scripts/x402-buy.ts stays the untouched vanilla interop proof). Every
 * function here is LLM-free: the model narrates and decides, this module
 * moves the money. Reused verbatim by the scripted fallback and the e2e
 * script, so all three paths exercise the same wire behavior.
 *
 * payMerchant NEVER throws — every failure (transport included) comes back as
 * a structured PayResult. That contract is load-bearing: a thrown tool run
 * reaches the LLM as a bare is_error result it might reasonably retry, and a
 * retry after the paid request was sent could pay twice.
 */

export type PayResult =
  | {
      success: true;
      handle: string;
      sgd: string;
      /** Token units actually paid (the ceil quote), 6dp decimal string. */
      amountToken: string;
      txHash?: string;
      explorerUrl?: string;
      /** On-chain payer — the PBM wallet, not the agent's key (non-custodial). */
      payer?: string;
      /** Set when settlement is confirmed but the tx hash is not yet known. */
      note?: string;
    }
  | {
      success: false;
      handle: string;
      sgd: string;
      errorReason: string;
      errorMessage: string;
    };

export type MerchantListEntry = MerchantResponse | { handle: string; error: string };

/** Lookup failures stay IN the result (with an `error` field) — silently
 * dropping a merchant would let the model conclude it doesn't exist and skip
 * the rejection beat entirely. */
export async function listMerchants(): Promise<MerchantListEntry[]> {
  const merchants: MerchantListEntry[] = [];
  for (const handle of Object.keys(DEMO_MERCHANTS)) {
    try {
      const res = await fetch(`${env.gantryApi}/api/merchants/${handle}`);
      if (res.ok) {
        merchants.push((await res.json()) as MerchantResponse);
      } else {
        console.error(`listMerchants: ${handle} lookup failed (${res.status})`);
        merchants.push({ handle, error: `lookup failed (status ${res.status})` });
      }
    } catch (err) {
      console.error(`listMerchants: ${handle} lookup threw`, err);
      merchants.push({ handle, error: "lookup failed (network error)" });
    }
  }
  return merchants;
}

export async function checkPolicy(): Promise<PolicyResponse> {
  const res = await fetch(`${env.gantryApi}/api/policy`);
  if (!res.ok) throw new Error(`GET /api/policy failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as PolicyResponse;
}

export async function payMerchant(handle: string, sgd: string): Promise<PayResult> {
  const { key, wallet } = requireSigningEnv();
  const orderUrl = `${env.gantryApi}/api/order/${handle}?sgd=${encodeURIComponent(sgd)}`;
  const fail = (errorReason: string, errorMessage: string): PayResult => ({
    success: false,
    handle,
    sgd,
    errorReason,
    errorMessage,
  });

  parseSgd(sgd); // fail fast on garbage before any HTTP

  // ------------------------------------------------------------------ pre-payment
  // Steps 1-5: nothing irreversible happens here (an abandoned intent just
  // expires), so a transport failure is safe to retry once.
  let offer: X402PaymentRequirements;
  let intent: PbmIntentResponse;
  let signature: `0x${string}`;
  let resource: { url: string } | undefined;
  try {
    // 1. The 402 challenge.
    const challenge = await fetch(orderUrl, { method: "POST" });
    if (challenge.status !== 402) {
      return fail("unexpected_status", `expected a 402 challenge, got ${challenge.status}`);
    }
    const requiredHeader = challenge.headers.get(PAYMENT_REQUIRED_HEADER);
    if (!requiredHeader) return fail("missing_header", "402 carried no PAYMENT-REQUIRED header");
    let required;
    try {
      required = decodePaymentRequiredHeader(requiredHeader);
    } catch {
      return fail("malformed_header", "PAYMENT-REQUIRED header did not decode (proxy mangling?)");
    }
    resource = required.resource;

    // 2. Select the pbm offer — never fall back to exact (the non-custodial
    //    path IS the story; a missing offer is a server misconfiguration).
    const pbmOffer = required.accepts.find(
      (a): a is X402PaymentRequirements => a.scheme === "gantry-pbm",
    );
    if (!pbmOffer) return fail("no_pbm_offer", "server offered no gantry-pbm accepts entry");
    offer = pbmOffer;

    // 3. Pre-create the intent the signature must bind.
    const intentEndpoint =
      typeof offer.extra["intentEndpoint"] === "string" ? offer.extra["intentEndpoint"] : "/api/pbm/intent";
    const xsgdAmount = typeof offer.extra["xsgdAmount"] === "string" ? offer.extra["xsgdAmount"] : "";
    const intentRes = await fetch(`${env.gantryApi}${intentEndpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, xsgdAmount }),
    });
    if (!intentRes.ok) {
      return fail(
        "intent_creation_failed",
        `POST ${intentEndpoint} → ${intentRes.status}: ${await intentRes.text()}`,
      );
    }
    intent = (await intentRes.json()) as PbmIntentResponse;

    // 4. Client-side quote guard: never sign an amount other than the pinned
    //    challenge amount.
    if (intent.amountIn !== offer.amount) {
      return fail("quote_changed", `intent quotes ${intent.amountIn} but the offer pinned ${offer.amount}`);
    }

    // 5. Session key signs SpendAuthorization — the only place the key is used.
    const account = privateKeyToAccount(key);
    signature = await account.signTypedData(reviveSpendAuthorization(intent.typedData, wallet));
  } catch (err) {
    return fail(
      "transport_error",
      `a pre-payment step failed (${err instanceof Error ? err.message : String(err)}) — ` +
        "nothing was paid; retrying once is safe",
    );
  }

  // ------------------------------------------------------------------ the payment
  // From the moment this request is in flight the backend may settle it —
  // a failure here is UNKNOWN, never retryable.
  try {
    const paid = await fetch(orderUrl, {
      method: "POST",
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
          x402Version: 2,
          ...(resource ? { resource } : {}),
          accepted: offer, // echoed verbatim — the middleware subset-matches it
          payload: { pbmWallet: wallet, intentId: intent.intentId, signature },
        }),
      },
    });

    // 7. The receipt travels in PAYMENT-RESPONSE on success AND failure.
    const responseHeader = paid.headers.get(PAYMENT_RESPONSE_HEADER);
    const receipt = responseHeader ? decodePaymentResponseHeader(responseHeader) : null;
    if (paid.ok && receipt?.success) {
      // transaction can legitimately be "" (settle landed after a receipt
      // timeout) — never emit a dangling explorer link for the model to read.
      const txHash = receipt.transaction || undefined;
      return {
        success: true,
        handle,
        sgd,
        amountToken: offer.amount,
        ...(txHash
          ? { txHash, explorerUrl: `${BASESCAN_BASE_URL}/tx/${txHash}` }
          : { note: "settled — tx hash pending the indexer; see the dashboard row" }),
        payer: receipt.payer,
      };
    }
    if (receipt) {
      return fail(receipt.errorReason ?? "settlement_failed", receipt.errorMessage ?? "settlement failed");
    }
    // A verify-stage rejection re-challenges: the fresh 402's error field says why.
    const rechallenge = paid.headers.get(PAYMENT_REQUIRED_HEADER);
    if (rechallenge) {
      const decoded = decodePaymentRequiredHeader(rechallenge);
      return fail(decoded.error ?? "verification_failed", `payment rejected at verify (status ${paid.status})`);
    }
    return fail("outcome_unknown", `paid retry returned ${paid.status} with no payment headers — the payment MAY have settled; do NOT retry, check the dashboard`);
  } catch (err) {
    return fail(
      "outcome_unknown",
      `the paid request failed mid-flight (${err instanceof Error ? err.message : String(err)}) — ` +
        "the payment MAY have settled; do NOT retry, check the dashboard",
    );
  }
}
