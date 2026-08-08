import { Router } from "express";
import { countSettlements, listSettlements } from "../db";
import { settlementEventOf } from "../indexer";
import { listSettlementHistory, type SettlementHistoryDeps } from "../services/settlements";

export const settlementsRouter = Router();

/** The store and mapper are wired here so the service itself stays importable
 * without opening the database — see the header of services/settlements.ts. */
const deps: SettlementHistoryDeps = {
  store: { listSettlements, countSettlements },
  toEvent: settlementEventOf,
};

/**
 * GET /api/settlements?handle=&payer=&before=&limit=
 *
 * Paged history for the merchant screens and the payer's activity feed —
 * synchronous, because it reads only the SQLite cache the indexer fills.
 */
settlementsRouter.get("/api/settlements", (req, res) => {
  res.json(listSettlementHistory(deps, req.query));
});
