import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  AssetAmount,
  Network,
  PaymentPayload,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { caip2, type X402PaymentPayload, type X402PaymentRequirements } from "@gantry/shared";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { config } from "./config";
import { getSupported } from "./services/facilitator";
import { settlePayment, verifyPayment } from "./services/schemes";
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
    return verifyPayment(payload as X402PaymentPayload, requirements as X402PaymentRequirements);
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return settlePayment(payload as X402PaymentPayload, requirements as X402PaymentRequirements);
  }

  async getSupported(): Promise<SupportedResponse> {
    return getSupported();
  }
}

/**
 * The resource-server side of the `gantry-pbm` scheme. The SDK requires a
 * registered SchemeNetworkServer per accepts[] scheme at boot
 * (validateRouteConfiguration) — this plus the matching kind in getSupported()
 * are a package deal; missing either bricks startup with a
 * RouteConfigurationError. Our order route always prices via buildOrderPrice
 * (an AssetAmount), so parsePrice is a passthrough and requirements need no
 * enrichment (ExactEvmScheme precedent).
 */
class GantryPbmScheme implements SchemeNetworkServer {
  readonly scheme = "gantry-pbm";

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price && price.asset) {
      return { amount: price.amount, asset: price.asset, extra: price.extra ?? {} };
    }
    throw new Error(`gantry-pbm requires an AssetAmount price on ${network} (money strings unsupported)`);
  }

  enhancePaymentRequirements(requirements: PaymentRequirements): Promise<PaymentRequirements> {
    return Promise.resolve(requirements);
  }
}

const resourceServer = new x402ResourceServer(new InProcessFacilitatorClient())
  .register(caip2(config.chainId), new ExactEvmScheme())
  .register(caip2(config.chainId), new GantryPbmScheme());

export const x402Middleware = paymentMiddleware(orderRoutes, resourceServer);
