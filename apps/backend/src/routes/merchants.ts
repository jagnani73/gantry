import { Router } from "express";
import { z } from "zod";
import type { Address } from "viem";
import { getMerchant, registerMerchant } from "../services/merchants";

export const merchantsRouter = Router();

// Shape only. Payout validation (EIP-55, zero-address) lives in the shared
// normalizePayout that registerMerchant calls, so the route and the form cannot
// drift apart on what counts as a valid address.
const RegisterMerchantSchema = z.object({
  handle: z.string(),
  payout: z.string(),
  categoryId: z.number().int(),
});

merchantsRouter.get("/api/merchants/:handle", async (req, res) => {
  res.json(await getMerchant(req.params.handle));
});

merchantsRouter.post("/api/merchants", async (req, res) => {
  const body = RegisterMerchantSchema.parse(req.body);
  res
    .status(201)
    .json(await registerMerchant({ ...body, payout: body.payout as Address }, req.ip));
});
