import { Router } from "express";
import { config } from "../config";
import { resetIndexer } from "../indexer";
import { broadcast } from "../sse";
import { ApiError } from "../errors";
import { armDemoPolicy } from "../services/policy";

export const adminRouter = Router();

function requireAdminToken(token: string | undefined): void {
  if (token !== config.adminToken) {
    throw new ApiError(401, "Unauthorized", "bad or missing x-admin-token");
  }
}

adminRouter.post("/api/admin/reset", async (req, res) => {
  requireAdminToken(req.get("x-admin-token"));
  await resetIndexer();
  broadcast("reset", null, { at: Math.floor(Date.now() / 1000) });
  res.json({ ok: true });
});

/** demo-reset's per-rehearsal re-arm: setPolicy (which resets the wallet's
 * spentToday) with the canonical demo policy, through the relayer = owner. */
adminRouter.post("/api/admin/policy/arm", async (req, res) => {
  requireAdminToken(req.get("x-admin-token"));
  res.json({ txHash: await armDemoPolicy() });
});
