import { Router } from "express";
import { z } from "zod";
import type { Address } from "viem";
import { getMerchant, registerMerchant } from "../services/merchants";

export const merchantsRouter = Router();

const RegisterMerchantSchema = z.object({
  handle: z.string(),
  payout: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x-prefixed address"),
  categoryId: z.coerce.number().int(),
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
