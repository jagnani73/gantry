import {
  caip2,
  type X402PaymentPayload,
  type X402PaymentRequirements,
  type X402SettleResponse,
  type X402VerifyResponse,
} from "@gantry/shared";
import { config } from "../config";
import { settleBridge } from "./bridge";
import { verifyExact, verifyPbm } from "./facilitator";
import { settlePbmScheme } from "./pbm";

/**
 * The facilitator's scheme dispatch — the single fork point both surfaces
 * (the in-process middleware client and the spec-shaped HTTP routes) call, so
 * they can never disagree about which handler serves a scheme. Unknown schemes
 * fail in-band (never thrown), matching the facilitator's failure invariant.
 */

export async function verifyPayment(
  payload: X402PaymentPayload,
  requirements: X402PaymentRequirements,
): Promise<X402VerifyResponse> {
  switch (requirements.scheme) {
    case "exact":
      return verifyExact(payload, requirements);
    case "gantry-pbm":
      return verifyPbm(payload, requirements);
    default:
      return {
        isValid: false,
        invalidReason: "unsupported_scheme",
        invalidMessage: `no facilitator handler for scheme "${requirements.scheme}"`,
      };
  }
}

export async function settlePayment(
  payload: X402PaymentPayload,
  requirements: X402PaymentRequirements,
): Promise<X402SettleResponse> {
  switch (requirements.scheme) {
    case "exact":
      return settleBridge(payload, requirements);
    case "gantry-pbm":
      return settlePbmScheme(payload, requirements);
    default:
      return {
        success: false,
        errorReason: "unsupported_scheme",
        errorMessage: `no facilitator handler for scheme "${requirements.scheme}"`,
        transaction: "",
        network: caip2(config.chainId),
      };
  }
}
