import { Router } from "express";
import { tokenAddress } from "@gantry/shared";
import { relayerAccount } from "../chain";
import { config } from "../config";
import { ApiError } from "../errors";
import { buildDiscoveryListing, parsePaging } from "../services/discovery-core";
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

  let rate: bigint;
  try {
    rate = await readRate("USDC");
  } catch {
    // Every listing carries a real quote, so without a rate there is nothing
    // honest to return — an amount we could not price would be a number a
    // client pays against and we refuse.
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
    rate,
    asset: tokenAddress(config.addresses, "USDC"),
    relayer: relayerAccount.address,
    core: config.addresses.gantryCore,
    limit,
    offset,
  });

  res.set("Cache-Control", "no-store");
  res.json(listing);
});
