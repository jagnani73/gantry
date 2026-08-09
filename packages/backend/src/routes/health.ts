import { Router } from "express";
import type { HealthResponse } from "@gantry/shared";
import { relayerAccount } from "../chain";
import { indexerStatus } from "../indexer";
import { config } from "../config";

export const healthRouter = Router();

/**
 * Nothing off-box on this path, by design — a local SQLite read for the cursor
 * is the whole cost. It used to await getBlockNumber(), which made every poll
 * an RPC call on a metered key and — worse — made the route fail whenever the
 * provider did. The deploy host polls this path and restarts the service when
 * it fails, so that wiring handed a third party the power to kill an instance,
 * taking the SQLite cache with it. The chain facts below come from the
 * indexer's own 15s sweep, which already reads head; a stale `headAt` says more
 * about RPC health than an on-demand read ever could, because it reports the
 * path the app actually depends on.
 */
healthRouter.get("/health", (_req, res) => {
  const body: HealthResponse = {
    ok: true,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    hostClass: config.hostClass,
    chainId: config.chainId,
    relayer: relayerAccount.address,
    indexer: indexerStatus(),
  };
  res.json(body);
});
