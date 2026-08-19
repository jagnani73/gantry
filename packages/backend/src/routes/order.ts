import { Router } from "express";
import type { HTTPRequestContext, RoutesConfig } from "@x402/core/server";
import {
  PAYABLE_TOKEN_IDS,
  PAYMENT_SIGNATURE_HEADER,
  TOKENS,
  caip2,
  decodePaymentSignatureHeader,
  formatUnits6,
  parseSgd,
  quoteAmountIn,
  tokenAddress,
  tokenIdByAddress,
  type TokenId,
} from "@gantry/shared";
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
function priceIn(token: TokenId) {
  return async function buildOrderPrice(context: HTTPRequestContext) {
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
  };
}

/**
 * What a client that expresses no preference is quoted.
 *
 * An UNMODIFIED x402 client takes `accepts[0]` without choosing, so the first
 * entry has to stay the currency the demo funds and every payer already holds.
 * Named here rather than leaning on whatever order `PAYABLE_TOKEN_IDS` happens
 * to have — that order comes from the key order of the TOKENS object, so tidying
 * the registry could otherwise move every vanilla client onto euros without
 * anyone touching this file.
 */
const VANILLA_DEFAULT_TOKEN: TokenId = "USDC";

/** Every payable token, the vanilla default first. */
const OFFER_TOKENS: readonly TokenId[] = [
  VANILLA_DEFAULT_TOKEN,
  ...PAYABLE_TOKEN_IDS.filter((id) => id !== VANILLA_DEFAULT_TOKEN),
];

const orderAccepts = [
  // `exact` MUST stay first: vanilla clients (and scripts/x402-buy.ts)
  // take the first matching entry. Funds route to the relayer — the
  // facilitator bridge's custodial hop.
  //
  // ONE ENTRY PER PAYABLE TOKEN, default first. The bridge was always
  // token-agnostic — it reads `requirements.asset` from collect through refund —
  // so the only thing making the STANDARDS door dollar-only was this list, while
  // our own scheme below already offered both. That asymmetry made "any currency
  // in" true of the doors we wrote and false of the door anyone else can use.
  // A client that wants euros asks through the SDK's own
  // `paymentRequirementsSelector`; one that asks for nothing is quoted dollars,
  // exactly as before.
  ...OFFER_TOKENS.map((token) => ({
    scheme: "exact",
    network: caip2(config.chainId),
    payTo: relayerAccount.address,
    price: priceIn(token),
    maxTimeoutSeconds: 600,
  })),
  // `gantry-pbm`: non-custodial — the wallet pushes straight into the core at
  // settle, so payTo is GantryCore itself. The static extra merges after the
  // price extra, adding the intent-endpoint hint the Gantry agent uses for the
  // pre-signing step.
  //
  // One entry per payable token here for a different reason: an agent wallet
  // spends a single currency (its caps are one number in one token's units), so
  // the server offers each and the agent takes the one matching what it holds. A
  // single USDC entry made a euro agent's intent disagree with the offer it was
  // answering, which surfaces as `quote_changed` — a confusing way to say "we
  // never offered euros".
  ...OFFER_TOKENS.map((token) => ({
    scheme: "gantry-pbm",
    network: caip2(config.chainId),
    payTo: config.addresses.gantryCore,
    price: priceIn(token),
    maxTimeoutSeconds: 600,
    extra: { intentEndpoint: "/api/pbm/intent" },
  })),
];
// Boot-time guards. The first: the vanilla-interop beat dies silently if a
// reorder ever demotes `exact` from accepts[0]. The second: so does it if the
// default currency stops being quotable, which would leave accepts[0] pointing
// at a token `readRate` refuses — a 402 nobody can pay, produced by a server
// that thinks it is fine.
if (orderAccepts[0]?.scheme !== "exact") {
  throw new Error("orderRoutes invariant violated: `exact` must be the first accepts entry");
}
if (!PAYABLE_TOKEN_IDS.includes(VANILLA_DEFAULT_TOKEN)) {
  throw new Error(
    `orderRoutes invariant violated: the vanilla default ${VANILLA_DEFAULT_TOKEN} must be payable`,
  );
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
/**
 * Which currency this order was actually paid in.
 *
 * The confirmation used to state `USDC` unconditionally, which was true only
 * while the `exact` door offered nothing else — the first euro payment through it
 * came back describing itself as dollars. Read instead from the PAYMENT-SIGNATURE
 * header the middleware has ALREADY verified: `accepted` is the client's echo of
 * an accepts[] entry, and the SDK subset-matches it against the server-built one
 * before this handler is reached, so by here the asset is the server's own and
 * not the caller's claim.
 *
 * Null rather than a default when the header is missing or unreadable. This body
 * is a courtesy — the receipt that matters travels in PAYMENT-RESPONSE — and a
 * field naming the wrong currency is worse than a field that is not there.
 */
function paidToken(header: string | undefined): TokenId | null {
  if (!header) return null;
  try {
    const asset = decodePaymentSignatureHeader(header).accepted?.asset;
    return asset ? tokenIdByAddress(config.addresses, asset) : null;
  } catch {
    return null;
  }
}

async function orderConfirmation(handle: string, sgd: string, token: TokenId | null) {
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
      ...(token ? { token } : {}),
    },
    message: "order confirmed: the settlement receipt travels in the PAYMENT-RESPONSE header",
  };
}

function requestedSgd(value: unknown): string {
  return typeof value === "string" ? value : "";
}

ordersRouter.post("/api/order/:handle", async (req, res) => {
  res.json(
    await orderConfirmation(
      String(req.params.handle),
      requestedSgd(req.query.sgd),
      paidToken(req.get(PAYMENT_SIGNATURE_HEADER)),
    ),
  );
});

ordersRouter.get("/pay/:handle", async (req, res) => {
  res.json(
    await orderConfirmation(
      String(req.params.handle),
      requestedSgd(req.query.sgd),
      paidToken(req.get(PAYMENT_SIGNATURE_HEADER)),
    ),
  );
});
