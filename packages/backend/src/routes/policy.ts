import { Router } from "express";
import type { RevokePolicyResponse } from "@gantry/shared";
import { config } from "../config";
import { ApiError } from "../errors";
import { readPolicy, revokePolicy } from "../services/policy";

export const policyRouter = Router();

policyRouter.get("/api/policy", async (_req, res) => {
  res.json(await readPolicy());
});

/** Browser-triggered (the dashboard's Revoke button) — relayer = wallet owner
 * signs the tx. Demo-grade: env-gated (SET POLICY_ADMIN_ENABLED=0 ON PUBLIC
 * HOSTS — an open revoke is a demo kill switch; the stage revoke runs against
 * the demo laptop's own backend) plus a cooldown so even an enabled instance
 * cannot be spammed into burning relayer gas. Re-arm lives behind the admin
 * token instead (POST /api/admin/policy/arm). */
const REVOKE_COOLDOWN_MS = 30_000;
let lastRevokeAt = 0;

policyRouter.post("/api/policy/revoke", async (_req, res) => {
  if (!config.policyAdminEnabled) {
    throw new ApiError(403, "PolicyAdminDisabled", "policy admin routes are disabled");
  }
  const now = Date.now();
  if (now - lastRevokeAt < REVOKE_COOLDOWN_MS) {
    throw new ApiError(429, "RevokeCooldown", "revoke was just called — wait a moment");
  }
  lastRevokeAt = now;
  const txHash = await revokePolicy();
  const body: RevokePolicyResponse = { txHash };
  res.json(body);
});
