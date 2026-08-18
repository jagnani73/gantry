import { Router } from "express";
import type { HTTPRequestContext, RoutesConfig } from "@x402/core/server";
import { TOKENS, caip2, formatUnits6, parseSgd, quoteAmountIn, tokenAddress } from "@gantry/shared";
import { relayerAccount } from "../chain";
import { config } from "../config";
import { ApiError } from "../errors";
import { orderPin, parseOrderResource } from "../services/facilitator-core";
import { payerAppOrigin, payerAppUrl, prefersHtml } from "../services/pay-link";
import { readRate } from "../services/intents";
import { getMerchant } from "../services/merchants";

/** The x402-protected demo resource: an agent orders from a merchant. Priced
 * by the `sgd` query param so the price survives into `resource.url` — the
 * bridge re-derives the same quote from that URL at settle time. */
export const ORDER_ROUTE = "POST /api/order/:handle";

/**
 * The pay link — the same order, at a URL a person can also open.
 *
 * `GET /pay/:handle?sgd=4.50` is x402-protected exactly like the route above,
 * and `payLinkRouter` (mounted BEFORE the middleware) peels off browsers first
 * and sends them to the payer app. So one string of characters is a payment
 * page for a human and a 402 for a machine, priced by the same function, paid
 * to the same shop, settled by the same contract call.
 *
 * It shares `orderAccepts` by reference rather than by copy: the boot assertion
 * that `exact` stays first then covers both doors, and a future edit cannot
 * make one door offer schemes the other does not.
 */
export const PAY_LINK_ROUTE = "GET /pay/:handle";

/** DynamicPrice for the 402 challenge AND its paid retry — it must resolve
 * identically both times (the middleware deep-equal-matches the rebuilt
 * requirement against what the client signed). That holds while the rate is
 * the owner-set FixedRateSwap; NOTE: an AMM-backed rate (a future AMM; GantrySwap was cancelled)
 * breaks this and would need a short-lived quote pin.
 *
 * Besides the price, this pins {handle, xsgdAmount} into requirements.extra —
 * the facts the bridge trusts at settle time. The extra is server-authored and
 * subset-matched against the client echo, so the client cannot redirect the
 * order to a different merchant. */
async function buildOrderPrice(context: HTTPRequestContext) {
  const order = parseOrderResource(context.adapter.getUrl());
  if (!order) {
    // Names both doors: this fires on /pay/:handle too, and an error quoting a
    // path the caller did not use reads as the server being confused rather
    // than as the amount being missing.
    throw new ApiError(
      400,
      "ValidationError",
      "expected /pay/:handle?sgd=<positive amount> or /api/order/:handle?sgd=…, e.g. ?sgd=1.50",
    );
  }
  await getMerchant(order.handle); // unknown merchant → 404 before any quote
  const xsgdAmount = parseSgd(order.sgd); // cannot throw: parseOrderResource validated it
  const token = "USDC" as const;
  let rate: bigint;
  try {
    rate = await readRate(token);
  } catch (err) {
    if (err instanceof ApiError) throw err; // TokenUnsupported stays a 400
    throw new ApiError(503, "QuoteUnavailable", "rate source unreachable; retry shortly");
  }
  // Same CEIL quote createIntent applies — keeps the bridge's equality guard true.
  const amount = quoteAmountIn(xsgdAmount, rate).toString();
  const asset = tokenAddress(config.addresses, token);
  const pins = { handle: order.handle, xsgdAmount: xsgdAmount.toString() };
  return {
    amount,
    asset,
    extra: {
      name: TOKENS[token].eip712.name,
      version: TOKENS[token].eip712.version,
      ...pins,
      // Says these facts came from THIS server. handle and xsgdAmount decide
      // which merchant gets paid, and on `exact` nothing else does — the
      // custodial hop makes payTo the relayer for every order, so the payer's
      // signature commits to an amount and a collector, never to a shop. The
      // SDK path is already safe (it matches the client echo against this
      // server-built entry), but POST /facilitator/settle takes requirements
      // straight from the request body and checks only their shape.
      //
      // Deterministic, which this function is REQUIRED to be: the middleware
      // rebuilds requirements and deep-equal-matches them, so the digest must
      // cover only fixed facts — no timestamp, no nonce.
      pin: orderPin({ ...pins, asset, amount }),
    },
  };
}

const orderAccepts = [
  // `exact` MUST stay first: vanilla clients (and scripts/x402-buy.ts)
  // take the first matching entry. Funds route to the relayer — the
  // facilitator bridge's custodial hop.
  {
    scheme: "exact",
    network: caip2(config.chainId),
    payTo: relayerAccount.address,
    price: buildOrderPrice,
    maxTimeoutSeconds: 600,
  },
  // `gantry-pbm`: non-custodial — the wallet pushes straight into the
  // core at settle, so payTo is GantryCore itself. Shares buildOrderPrice
  // deliberately (one deterministic quote, one drift surface); the static
  // extra merges after the price extra, adding the intent-endpoint hint
  // the Gantry agent uses for the pre-signing step.
  {
    scheme: "gantry-pbm",
    network: caip2(config.chainId),
    payTo: config.addresses.gantryCore,
    price: buildOrderPrice,
    maxTimeoutSeconds: 600,
    extra: { intentEndpoint: "/api/pbm/intent" },
  },
];
// Boot-time guard: the vanilla-interop beat dies silently if a reorder ever
// demotes `exact` from accepts[0].
if (orderAccepts[0]?.scheme !== "exact") {
  throw new Error("orderRoutes invariant violated: `exact` must be the first accepts entry");
}

export const orderRoutes: RoutesConfig = {
  [ORDER_ROUTE]: {
    accepts: orderAccepts,
    description: "Gantry order: pay a Singapore hawker in stablecoins over x402",
    mimeType: "application/json",
    // No `resource` override: the middleware then uses the full request URL
    // (query included), which is what carries the price to the bridge.
  },
  [PAY_LINK_ROUTE]: {
    accepts: orderAccepts,
    description: "Gantry pay link: one URL a person opens and a machine pays",
    mimeType: "application/json",
  },
};

/**
 * The browser half of the pay link, and the reason it can exist at all.
 *
 * Mounted BEFORE the x402 middleware so a person never sees a 402: a client
 * that names html is redirected into the payer app, and everything else falls
 * through to be challenged. `prefersHtml` is deliberately stricter than
 * `req.accepts` — see its docstring; the naive version hands agents an HTML
 * redirect and silently closes the machine door.
 *
 * The amount is NOT validated here. An amount-less `/pay/:handle` is the
 * ordinary human link and must open the shop's amount screen, and a malformed
 * one belongs in front of the payer, who can see and fix it — failing it here
 * would answer a mistyped price with a bare API error on a phone. Machines get
 * the strict path instead: `buildOrderPrice` rejects anything `parseOrderResource`
 * will not accept, before a challenge is ever issued.
 */
export const payLinkRouter = Router();

payLinkRouter.get("/pay/:handle", (req, res, next) => {
  // One URL, two answers, so the answer depends on a request header — say so
  // before branching. Express sets this on the redirect by itself; declaring it
  // up front covers the 402 too, where an intermediary handing a browser a
  // cached payment challenge would look exactly like the feature being broken.
  res.vary("Accept");
  if (!prefersHtml(req.headers.accept)) {
    next();
    return;
  }
  // Null means the host is not one we may safely reflect into a Location and no
  // APP_URL was configured — see payerAppOrigin. Refuse rather than guess: an
  // open redirect one hop before someone signs a payment is worth a broken
  // human path on a misconfigured host.
  const origin = payerAppOrigin(config.appUrl, req.protocol, req.hostname, config.appPort);
  if (origin === null) {
    throw new ApiError(
      500,
      "PayLinkNotConfigured",
      "this host cannot resolve the payer app; set APP_URL",
    );
  }
  const sgd = typeof req.query.sgd === "string" && req.query.sgd !== "" ? req.query.sgd : null;
  // 302 rather than 301: which host serves the payer app is deployment state,
  // and a permanent redirect would be cached against the next network the
  // laptop joins.
  res.redirect(302, payerAppUrl(origin, String(req.params.handle).toLowerCase(), sgd));
});

/** Runs only after the middleware verified payment; settlement happens after
 * this handler returns (the client's receipt is the PAYMENT-RESPONSE header,
 * this body is just the order confirmation). */
export const ordersRouter = Router();

/** One body for both doors. Two handlers that formatted their own confirmation
 * would be free to drift, and "the two doors agree" is the entire claim. */
async function orderConfirmation(handle: string, sgd: string) {
  const merchant = await getMerchant(handle);
  let xsgdAmount: bigint;
  try {
    xsgdAmount = parseSgd(sgd);
  } catch {
    throw new ApiError(400, "ValidationError", `sgd must be a decimal SGD amount, got "${sgd}"`);
  }
  return {
    order: {
      handle: merchant.handle,
      ...(merchant.displayName ? { displayName: merchant.displayName } : {}),
      ...(merchant.location ? { location: merchant.location } : {}),
      sgd: formatUnits6(xsgdAmount),
      xsgdAmount: xsgdAmount.toString(),
      token: "USDC" as const,
    },
    message: "order confirmed: the settlement receipt travels in the PAYMENT-RESPONSE header",
  };
}

function requestedSgd(value: unknown): string {
  return typeof value === "string" ? value : "";
}

ordersRouter.post("/api/order/:handle", async (req, res) => {
  res.json(await orderConfirmation(String(req.params.handle), requestedSgd(req.query.sgd)));
});

ordersRouter.get("/pay/:handle", async (req, res) => {
  res.json(await orderConfirmation(String(req.params.handle), requestedSgd(req.query.sgd)));
});
