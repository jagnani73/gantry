import { Router } from "express";
import { countSettlements, listSettlements, sumSettlements } from "../db";
import { settlementEventOf } from "../indexer";
import {
  listSettlementHistory,
  summariseSettlements,
  type SettlementHistoryDeps,
} from "../services/settlements";

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

/**
 * GET /api/settlements/summary?handle=&payer=&since=
 *
 * Totals over the whole matching book from `since`, for the merchant Overview's
 * KPI tiles. Registered AFTER the list route, which is safe because Express
 * matches these paths exactly rather than as a prefix — but keep them in this
 * order anyway, since a future `/api/settlements/:something` would not be.
 *
 * Synchronous like its sibling: it is an aggregate over the same SQLite cache,
 * and `/health` deliberately makes no RPC call for the same reason.
 */
settlementsRouter.get("/api/settlements/summary", (req, res) => {
  res.json(summariseSettlements({ sumSettlements }, req.query));
});
