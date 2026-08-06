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
 * signs the tx. Demo-grade and env-gated, faucet precedent; the re-arm lives
 * behind the admin token instead (POST /api/admin/policy/arm). */
policyRouter.post("/api/policy/revoke", async (_req, res) => {
  if (!config.policyAdminEnabled) {
    throw new ApiError(403, "PolicyAdminDisabled", "policy admin routes are disabled");
  }
  const txHash = await revokePolicy();
  const body: RevokePolicyResponse = { txHash };
  res.json(body);
});
