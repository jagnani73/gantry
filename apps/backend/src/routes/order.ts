import { Router } from "express";
import type { HTTPRequestContext, RoutesConfig } from "@x402/core/server";
import { TOKENS, caip2, formatUnits6, parseSgd, quoteAmountIn, tokenAddress } from "@gantry/shared";
import { relayerAccount } from "../chain";
import { config } from "../config";
import { ApiError } from "../errors";
import { parseOrderResource } from "../services/facilitator-core";
import { readRate } from "../services/intents";
import { getMerchant } from "../services/merchants";

/** The x402-protected demo resource: an agent orders from a merchant. Priced
 * by the `sgd` query param so the price survives into `resource.url` — the
 * bridge re-derives the same quote from that URL at settle time. */
export const ORDER_ROUTE = "POST /api/order/:handle";

/** DynamicPrice for the 402 challenge AND its paid retry — it must resolve
 * identically both times (the middleware deep-equal-matches the rebuilt
 * requirement against what the client signed), which holds because the quote
 * is a pure ceil at the owner-set fixed rate. */
async function buildOrderPrice(context: HTTPRequestContext) {
  const order = parseOrderResource(context.adapter.getUrl());
  if (!order) {
    throw new ApiError(400, "ValidationError", "expected /api/order/:handle?sgd=<amount>, e.g. ?sgd=6.50");
  }
  await getMerchant(order.handle); // unknown merchant → 404 before any quote
  let xsgdAmount: bigint;
  try {
    xsgdAmount = parseSgd(order.sgd);
  } catch {
    throw new ApiError(400, "ValidationError", `sgd must be a decimal SGD amount, got "${order.sgd}"`);
  }
  const token = config.orderToken;
  const rate = await readRate(token);
  return {
    // Same CEIL quote createIntent applies — keeps the bridge's equality guard true.
    amount: quoteAmountIn(xsgdAmount, rate).toString(),
    asset: tokenAddress(config.addresses, token),
    extra: { name: TOKENS[token].eip712.name, version: TOKENS[token].eip712.version },
  };
}

export const orderRoutes: RoutesConfig = {
  [ORDER_ROUTE]: {
    accepts: {
      scheme: "exact",
      network: caip2(config.chainId),
      payTo: relayerAccount.address,
      price: buildOrderPrice,
      maxTimeoutSeconds: 600,
    },
    description: "Gantry order: pay a Singapore hawker in stablecoins over x402",
    mimeType: "application/json",
    // No `resource` override: the middleware then uses the full request URL
    // (query included), which is what carries the price to the bridge.
  },
};

/** Runs only after the middleware verified payment; settlement happens after
 * this handler returns (the client's receipt is the PAYMENT-RESPONSE header,
 * this body is just the order confirmation). */
export const ordersRouter = Router();

ordersRouter.post("/api/order/:handle", async (req, res) => {
  const handle = String(req.params.handle);
  const sgd = typeof req.query.sgd === "string" ? req.query.sgd : "";
  const merchant = await getMerchant(handle);
  let xsgdAmount: bigint;
  try {
    xsgdAmount = parseSgd(sgd);
  } catch {
    throw new ApiError(400, "ValidationError", `sgd must be a decimal SGD amount, got "${sgd}"`);
  }
  res.json({
    order: {
      handle: merchant.handle,
      ...(merchant.displayName ? { displayName: merchant.displayName } : {}),
      ...(merchant.location ? { location: merchant.location } : {}),
      sgd: formatUnits6(xsgdAmount),
      xsgdAmount: xsgdAmount.toString(),
      token: config.orderToken,
    },
    message: "order confirmed — the settlement receipt travels in the PAYMENT-RESPONSE header",
  });
});
