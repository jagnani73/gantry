import { Router } from "express";
import { countDenials, listDenials } from "../db";
import { listAgentDenials } from "../services/pbm-core";

export const denialsRouter = Router();

/**
 * GET /api/denials?wallet=0x… — agent payments a PBM wallet refused.
 *
 * Payer-side only, which is why `wallet` is required rather than a filter: a
 * denial says what an agent may buy and where it hit its cap, so the merchant
 * surface is deliberately blind to it — nothing was ever presented to the shop,
 * and an agent stopped by its owner's policy is a guardrail working, not a
 * failed sale.
 *
 * Synchronous: nothing was mined, so there is nothing to read but the cache.
 */
denialsRouter.get("/api/denials", (req, res) => {
  res.json(listAgentDenials({ listDenials, countDenials }, req.query));
});
