import { Router } from "express";
import { z } from "zod";
import type { RevokePolicyResponse, SetPolicyResponse } from "@gantry/shared";
import { config } from "../config";
import { ApiError } from "../errors";
import { readPolicy, revokePolicy, setPolicy } from "../services/policy";

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

/**
 * Editing the policy is gated exactly like revoking it, and for a stronger
 * reason: revoke can only ever DENY, while an open setPolicy would let a visitor
 * RAISE the agent's caps or widen its categories. Same env gate, same cooldown
 * (each call burns relayer gas), and the same demo-host-only posture.
 */
const SET_COOLDOWN_MS = 10_000;
let lastSetAt = 0;

/** Shape only — the value rules (per-tx <= daily, known categories, positive
 * expiry) live in the service so the route cannot drift from them. */
const SetPolicySchema = z.object({
  dailyCapSgd: z.string(),
  perTxCapSgd: z.string(),
  categoryIds: z.array(z.number().int()),
  expiryDays: z.number().int(),
});

policyRouter.post("/api/policy", async (req, res) => {
  if (!config.policyAdminEnabled) {
    throw new ApiError(403, "PolicyAdminDisabled", "policy admin routes are disabled");
  }
  const now = Date.now();
  if (now - lastSetAt < SET_COOLDOWN_MS) {
    throw new ApiError(429, "SetPolicyCooldown", "policy was just updated — wait a moment");
  }
  // Recorded only on success, matching registerMerchant and the faucet: a
  // rejected edit (bad caps, unknown category) must surface its real error on
  // the next attempt rather than a bogus 429 that hides it for 10 seconds.
  const txHash = await setPolicy(SetPolicySchema.parse(req.body));
  lastSetAt = Date.now();
  // Return the re-read policy so the console never has to guess whether its own
  // write landed — the read that follows a write is exactly where a lagging
  // replica makes a confirmed change look like a failure.
  const body: SetPolicyResponse = { txHash, policy: await readPolicy() };
  res.json(body);
});

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
