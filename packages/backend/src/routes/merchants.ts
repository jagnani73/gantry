import { Router } from "express";
import { z } from "zod";
import type { Address } from "viem";
import {
  getMerchant,
  listMerchantIndex,
  registerMerchant,
  updateMerchantProfile,
} from "../services/merchants";

export const merchantsRouter = Router();

// Shape only. Payout validation (EIP-55, zero-address) lives in the shared
// normalizePayout that registerMerchant calls, and the profile bounds live in
// normalizeProfile, so the route and the form cannot drift apart on what counts
// as a valid address or an acceptable name.
const RegisterMerchantSchema = z.object({
  handle: z.string(),
  payout: z.string(),
  categoryId: z.number().int(),
  // Required because onboarding is the only moment we can ask — the handle is
  // claimed on-chain and permanent, so a shop that skipped its name here would
  // have no way to be recognised later. They ride in the same transaction, so a
  // shop onboarded THROUGH THIS ROUTE can never be live and unnamed. The
  // contract itself checks length only and `registerMerchant` is permissionless,
  // so a nameless merchant remains representable on-chain — which is why every
  // display field is optional on the way back out.
  displayName: z.string(),
  location: z.string(),
  blurb: z.string(),
});

const UpdateMerchantProfileSchema = z.object({
  displayName: z.string(),
  location: z.string(),
  blurb: z.string(),
});

/**
 * The public directory index. Unfiltered, unranked and unpaged by decision: it
 * is the whole census in registration order, and the page searches what it
 * loaded. Anything else here would be a ranking, which is the curation this
 * surface exists to disclaim.
 *
 * Declared before `/:handle` for readability only: Express matches these as
 * distinct paths in either order, since `/:handle` requires a further segment.
 */
merchantsRouter.get("/api/merchants", (_req, res) => {
  res.json(listMerchantIndex());
});

merchantsRouter.get("/api/merchants/:handle", async (req, res) => {
  res.json(await getMerchant(req.params.handle));
});

merchantsRouter.post("/api/merchants", async (req, res) => {
  const body = RegisterMerchantSchema.parse(req.body);
  res
    .status(201)
    .json(
      await registerMerchant(
        { ...body, payout: body.payout as Address },
        req.ip,
        req.get("x-admin-token"),
      ),
    );
});

/**
 * Rewrites a shop's display record on-chain, and nothing else — the contract's
 * `setMerchantProfile` provably cannot touch payout, handle or category.
 * Unauthenticated by decision (there is no merchant login), which is why the
 * service gates it on the host class and throttles it per IP; the admin token is
 * the operator escape hatch demo-reset seeds through.
 */
merchantsRouter.patch("/api/merchants/:handle", async (req, res) => {
  const body = UpdateMerchantProfileSchema.parse(req.body);
  res.json(
    await updateMerchantProfile(req.params.handle, body, req.ip, req.get("x-admin-token")),
  );
});
