import { Router } from "express";
import { z } from "zod";
import type { Address } from "viem";
import { getMerchant, registerMerchant, updateMerchantProfile } from "../services/merchants";

export const merchantsRouter = Router();

// Shape only. Payout validation (EIP-55, zero-address) lives in the shared
// normalizePayout that registerMerchant calls, and the profile bounds live in
// normalizeProfile, so the route and the form cannot drift apart on what counts
// as a valid address or an acceptable name.
const RegisterMerchantSchema = z.object({
  handle: z.string(),
  payout: z.string(),
  categoryId: z.number().int(),
  // Display facts the chain does not store. Required because onboarding is the
  // only moment we can ask — the handle is claimed on-chain and permanent, so a
  // shop that skipped its name here would have no way to be recognised later.
  displayName: z.string(),
  location: z.string(),
  blurb: z.string(),
});

const UpdateMerchantProfileSchema = z.object({
  displayName: z.string(),
  location: z.string(),
  blurb: z.string(),
});

// The display surfaces (merchant page, receipt, payer's "places you've paid")
// are the only readers of `registeredAt`, so this is the one caller that waits
// for it — the payment path takes whatever is already resolved.
merchantsRouter.get("/api/merchants/:handle", async (req, res) => {
  res.json(await getMerchant(req.params.handle, { waitForRegisteredAt: true }));
});

merchantsRouter.post("/api/merchants", async (req, res) => {
  const body = RegisterMerchantSchema.parse(req.body);
  res
    .status(201)
    .json(await registerMerchant({ ...body, payout: body.payout as Address }, req.ip));
});

/**
 * Rewrites the off-chain display record. Unauthenticated by decision (there is
 * no merchant login), which is why the service gates it on the host class and
 * throttles it per IP; the admin token is the operator escape hatch demo-reset
 * seeds through.
 */
merchantsRouter.patch("/api/merchants/:handle", async (req, res) => {
  const body = UpdateMerchantProfileSchema.parse(req.body);
  res.json(
    await updateMerchantProfile(req.params.handle, body, req.ip, req.get("x-admin-token")),
  );
});
