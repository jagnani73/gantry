import { Router } from "express";
import { OFFER_TOKEN_IDS, TOKENS, tokenAddress } from "@gantry/shared";
import { relayerAccount } from "../chain";
import { config } from "../config";
import { ApiError } from "../errors";
import {
  buildDiscoveryListing,
  parsePaging,
  type DiscoveryOfferToken,
} from "../services/discovery-core";
import { listMerchantIndex } from "../services/merchants";
import { readRate } from "../services/intents";

/**
 * `GET /discovery/resources` — the rail, enumerable by a machine.
 *
 * Everything else here assumes a human already picked the shop. An agent has no
 * counter to stand at, so this is the step that was missing: list the shops, get
 * back payable endpoints, pay one. No human at any point in that loop, which is
 * a claim only available to us because we hold both the merchant registry and
 * the machine door.
 *
 * Served in the x402 Bazaar's `DiscoveryResourcesResponse` shape so a client
 * that already speaks discovery needs no Gantry-specific code. **We are not a
 * Bazaar registry**: this lists our own index and publishes to nobody else's
 * catalog. See services/discovery-core.ts.
 */
export const discoveryRouter = Router();

discoveryRouter.get("/discovery/resources", async (req, res) => {
  const index = listMerchantIndex();

  // One rate per offered currency, in the same order the 402 offers them, so a
  // listing and the challenge it points at can never advertise different sets.
  // All-or-nothing: every listing carries a real quote, so a currency we could
  // not price would be a number a client pays against and we then refuse.
  let tokens: DiscoveryOfferToken[];
  try {
    tokens = await Promise.all(
      OFFER_TOKEN_IDS.map(async (id) => ({
        name: TOKENS[id].eip712.name,
        asset: tokenAddress(config.addresses, id),
        rate: await readRate(id),
      })),
    );
  } catch (err) {
    // Same shape as `priceIn` in routes/order.ts, and for the same reason: a
    // bare catch here reported a PERMANENT fault as a transient one. `readRate`
    // throws ApiError(400, TokenUnsupported) when the swap has no rate listed
    // for a token — a config error that will never clear — and collapsing that
    // into "retry shortly" leaves a machine retrying forever while the operator
    // sees neither the reason nor the cause.
    if (err instanceof ApiError) throw err; // TokenUnsupported stays a 400
    console.error("discovery: rate read failed", err);
    throw new ApiError(503, "QuoteUnavailable", "rate source unreachable; retry shortly");
  }

  const { limit, offset } = parsePaging(req.query.limit, req.query.offset);
  const listing = buildDiscoveryListing({
    merchants: index.merchants,
    // Derived from the host this request ARRIVED on, which is the host the
    // caller already chose to trust — unlike the pay link's redirect, nobody
    // else is sent anywhere by this response. It is still client-influenced
    // (Host, or X-Forwarded-Host behind the trusted proxy hop), so the response
    // is `no-store`: a shared cache must never hand one caller's derived origin
    // to another. A CDN in front of this would need to vary on the forwarded
    // host, or be given a pinned origin instead.
    origin: `${req.protocol}://${req.get("host") ?? `localhost:${config.port}`}`,
    chainId: config.chainId,
    tokens,
    relayer: relayerAccount.address,
    core: config.addresses.gantryCore,
    limit,
    offset,
    // The registry's own count, not the length of the (capped) page above.
    total: index.total,
  });

  res.set("Cache-Control", "no-store");
  // The same caveat `/api/merchants` carries, and it matters MORE here.
  //
  // A bare local read cannot tell "the rail is empty" from "this host has not
  // indexed it yet", and every deploy wipes SQLite and starts a ~35-minute cold
  // backfill — during which this answers 200 with an empty `items`. The reason a
  // caveat was enough on the human directory ("nobody acts on this list") is
  // inverted here: acting on the list is the whole point of the endpoint, and
  // there is no human to notice it looked thin.
  //
  // Additive and outside the Bazaar shape's required fields, so a client that
  // does not know about it is unaffected.
  res.json({ ...listing, indexer: index.indexer });
});
