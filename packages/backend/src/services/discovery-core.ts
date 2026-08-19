import { caip2, formatUnits6, quoteAmountIn, type MerchantSummary } from "@gantry/shared";

/**
 * Every registered shop, as resources a machine can find and pay.
 *
 * The rest of this product assumes a human already knows which shop they want:
 * they scanned its code, or tapped it in a list. An agent has no counter to
 * stand at. This is the missing step — enumerate the rail, get back payable
 * endpoints, pay one — and it is only available to us because we hold both a
 * merchant registry and a machine door. There is no human anywhere in that loop.
 *
 * Shaped as the x402 Bazaar's `DiscoveryResourcesResponse` (`@x402/extensions`,
 * pinned at the same 2.21.0 as the rest of the SDK) rather than as something of
 * our own. That is the whole point of a discovery format: a client that already
 * speaks it needs no Gantry-specific code.
 *
 * **We are not a Bazaar registry and must never say we are.** This serves the
 * shape from our own index; it does not publish to, mirror, or belong to anyone
 * else's catalog. Say "a discovery endpoint in the Bazaar's shape".
 *
 * Pure and config-free so the shape is unit-testable without a chain or a
 * server — the facilitator-core precedent.
 */

/** The listed price. Every entry is payable EXACTLY as written, so this has to
 * be a real quote rather than a placeholder; a caller wanting another amount
 * changes `sgd` and the endpoint prices that instead. One round number, because
 * it appears in every listing and a hawker-scale figure keeps the demo honest. */
export const SAMPLE_SGD_UNITS = 1_000_000n;

/**
 * The same figure as the string a caller pays against.
 *
 * The listed price used to be spelled three times — once derived
 * (`quoteAmountIn(SAMPLE_SGD_UNITS, …)`) and twice as the literal `"1.00"`, in
 * `extra.sgd` and in the `?sgd=` of the resource URL. Changing the constant
 * moved only the first, so every listing would have advertised a quote for one
 * amount against a URL naming another, and a vanilla client paying the listing
 * verbatim would be refused at settle for quoting wrong. Deriving it makes the
 * "payable exactly as written" property structural rather than remembered.
 */
export const SAMPLE_SGD = formatUnits6(SAMPLE_SGD_UNITS);

/** One currency a listing can be paid in, priced. */
export interface DiscoveryOfferToken {
  /** The EIP-712 token name — the same key the 402's `extra` carries, so a
   * client selects a currency the same way in a listing and in a challenge. */
  name: string;
  /** The EIP-712 domain version, carried for the same reason as `name`: a
   * client building a signing domain from a listing needs both, and omitting it
   * left the two `extra`s differing in more than the server-issued pin. */
  version: string;
  asset: string;
  /** XSGD 6dp out per 1e6 token units, from FixedRateSwap. Per token, because
   * the quote differs and a listing must carry the real one. */
  rate: bigint;
}

export interface DiscoveryInputs {
  merchants: MerchantSummary[];
  /** Absolute origin this server is reachable at — the listing must be payable
   * by whoever reads it, so a relative path would be useless to an agent. */
  origin: string;
  chainId: number;
  /**
   * Every currency this rail accepts, in `OFFER_TOKEN_IDS` order.
   *
   * A LIST rather than one token because a listing describes the same resource
   * the 402 does, and the two must offer the same set: when only the challenge
   * learned to fan out, discovery advertised dollars alone and a euro-only agent
   * reading it would have concluded the shop could not take its money.
   */
  tokens: DiscoveryOfferToken[];
  /** `exact` collects to the relayer (the custodial hop); `gantry-pbm` pushes
   * straight into the core. Both are offered on every shop, in that order. */
  relayer: string;
  core: string;
  limit: number;
  offset: number;
  /**
   * How many merchants are on the rail ALTOGETHER — not `merchants.length`.
   *
   * Passed in rather than measured, because `merchants` is itself a capped read
   * (`listMerchants` stops at MERCHANT_LIST_LIMIT) and measuring it made `total`
   * describe the page while claiming to describe the registry. A client paging
   * by `offset` would then believe it had enumerated the whole rail at the cap.
   */
  total: number;
}

export interface DiscoveryListing {
  x402Version: number;
  items: DiscoveryItem[];
  pagination: { limit: number; offset: number; total: number };
}

export interface DiscoveryItem {
  resource: string;
  type: "http";
  x402Version: number;
  accepts: {
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: Record<string, unknown>;
  }[];
  lastUpdated: string;
  description: string;
  mimeType: "application/json";
  serviceName: string;
  tags: string[];
}

/**
 * Build the listing.
 *
 * `lastUpdated` is the shop's REGISTRATION time, not the moment this response
 * was built. A timestamp that moved on every request would tell a caching
 * client that every shop had changed, on a list that changes only when someone
 * registers.
 */
export function buildDiscoveryListing(inputs: DiscoveryInputs): DiscoveryListing {
  const { merchants, origin, chainId, tokens, relayer, core, limit, offset, total } = inputs;
  const network = caip2(chainId);
  const base = origin.replace(/\/+$/, "");

  const items = merchants.slice(offset, offset + limit).map((merchant): DiscoveryItem => {
    const shop = merchant.displayName ?? merchant.handle;
    const accept = (scheme: string, payTo: string, token: DiscoveryOfferToken) => ({
      scheme,
      network,
      asset: token.asset,
      // Priced per currency. A shared amount would be right for one of them and
      // a number the settle refuses for the rest, which makes a listing that
      // claims to be payable verbatim into decoration.
      amount: quoteAmountIn(SAMPLE_SGD_UNITS, token.rate).toString(),
      payTo,
      maxTimeoutSeconds: 600,
      // Mirrors the 402's `extra` apart from the pin, which is issued per
      // challenge and cannot be published in a listing.
      extra: { handle: merchant.handle, sgd: SAMPLE_SGD, name: token.name, version: token.version },
    });
    return {
      // Carries the amount it is listed at, so an agent can pay this string
      // verbatim. The endpoint prices whatever `sgd` asks for.
      resource: `${base}/pay/${merchant.handle}?sgd=${SAMPLE_SGD}`,
      type: "http",
      x402Version: 2,
      // Scheme-major, then currency — byte-for-byte the order the pay link's own
      // accepts[] uses, because these describe the same resource. `exact` in the
      // default currency leads: a vanilla client takes the first entry, and a
      // listing that led with anything else would hand it either a scheme only
      // our agent implements or a currency it does not hold.
      accepts: [
        ...tokens.map((t) => accept("exact", relayer, t)),
        ...tokens.map((t) => accept("gantry-pbm", core, t)),
      ],
      lastUpdated: new Date(merchant.registeredAt * 1000).toISOString(),
      description: `Pay ${shop} in stablecoins. Any amount: change the sgd query parameter. Settles to the merchant in XSGD.`,
      mimeType: "application/json",
      serviceName: shop,
      // Category first so a client filtering by kind of shop has something to
      // match; the rest describe the rail rather than the merchant.
      tags: [merchant.categoryName, "gantry", "hawker", "singapore"],
    };
  });

  return {
    x402Version: 2,
    items,
    // `total` is the whole registry, not the page — a client cannot tell a
    // capped response from the end of the list without it. It comes from the
    // caller's own count for that reason; see the field's note on `DiscoveryInputs`.
    pagination: { limit, offset, total },
  };
}

/** Clamp paging so a caller cannot ask for the entire registry in one response
 * or walk off the end of it. Non-numeric input falls back rather than throwing:
 * this is a discovery endpoint, and refusing to list anything because a query
 * param was junk helps nobody. */
export function parsePaging(
  rawLimit: unknown,
  rawOffset: unknown,
  max = 100,
): { limit: number; offset: number } {
  const asInt = (value: unknown, fallback: number, min: number) => {
    const n = typeof value === "string" ? Number.parseInt(value, 10) : NaN;
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  // `limit` floors at 1, not 0. `?limit=0` is not a request for an empty page —
  // it is the shape a client sends when its own paging arithmetic produced a
  // zero, and answering with `items: []` beside a non-zero `total` reads as "the
  // rail is empty at this offset" and ends the walk. `offset` may legitimately
  // be 0, which is why the floors differ.
  return {
    limit: Math.min(asInt(rawLimit, max, 1), max),
    offset: asInt(rawOffset, 0, 0),
  };
}
