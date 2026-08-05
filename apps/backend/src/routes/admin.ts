import { Router } from "express";
import { config } from "../config";
import { clearCache } from "../db";
import { resetCursorToHead } from "../indexer";
import { broadcast } from "../sse";
import { ApiError } from "../errors";

export const adminRouter = Router();

adminRouter.post("/api/admin/reset", async (req, res) => {
  if (req.get("x-admin-token") !== config.adminToken) {
    throw new ApiError(401, "Unauthorized", "bad or missing x-admin-token");
  }
  clearCache();
  await resetCursorToHead();
  broadcast("reset", null, { at: Math.floor(Date.now() / 1000) });
  res.json({ ok: true });
});
