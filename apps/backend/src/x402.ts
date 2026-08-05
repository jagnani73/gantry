import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { caip2, type X402PaymentPayload, type X402PaymentRequirements } from "@gantry/shared";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { config } from "./config";
import { settleBridge } from "./services/bridge";
import { getSupported, verifyExact } from "./services/facilitator";
import { orderRoutes } from "./routes/order";

/**
 * The middleware talks to our facilitator in-process rather than over HTTP:
 * `paymentMiddleware` syncs `/supported` at construction (before listen — a
 * self-HTTP call would ECONNREFUSED) and the HTTP client's default 30s timeout
 * is too tight for the bridge's three serialized transactions. The spec-shaped
 * HTTP surface still exists at /facilitator/* backed by the same services.
 * The SDK and owned types are structurally compatible: outbound returns
 * type-check as plain assignments; only the inbound direction needs `as`
 * (SDK `string` fields narrowing to Address/Hex/literal), and every inbound
 * claim is re-validated by value checks before consequential use.
 */
class InProcessFacilitatorClient implements FacilitatorClient {
  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return verifyExact(payload as X402PaymentPayload, requirements as X402PaymentRequirements);
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return settleBridge(payload as X402PaymentPayload, requirements as X402PaymentRequirements);
  }

  async getSupported(): Promise<SupportedResponse> {
    return getSupported();
  }
}

const resourceServer = new x402ResourceServer(new InProcessFacilitatorClient()).register(
  caip2(config.chainId),
  new ExactEvmScheme(),
);

export const x402Middleware = paymentMiddleware(orderRoutes, resourceServer);
