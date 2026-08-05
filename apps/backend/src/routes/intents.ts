import { Router } from "express";
import { z } from "zod";
import type { Hex } from "viem";
import { createIntent, getIntentStatusResponse, requoteIntent } from "../services/intents";
import { settle } from "../services/settlement";
import { faucetMint } from "../services/faucet";

export const intentsRouter = Router();

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x-prefixed 32-byte hex");
const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x-prefixed address");

const CreateIntentSchema = z.object({
  handle: z.string(),
  xsgdAmount: z.string(),
  token: z.enum(["MUSDC", "USDC", "XSGD"]).optional(),
  door: z.enum(["human", "agent"]).optional(),
});

const SettleSchema = z.object({
  payer: hexAddress,
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "expected 65-byte hex signature"),
  validAfter: z.string().regex(/^\d+$/).optional(),
  validBefore: z.string().regex(/^\d+$/).optional(),
});

const FaucetSchema = z.object({ address: hexAddress });

intentsRouter.post("/api/intents", async (req, res) => {
  const body = CreateIntentSchema.parse(req.body);
  res.status(201).json(await createIntent(body));
});

intentsRouter.get("/api/intents/:intentId", async (req, res) => {
  const intentId = hex32.parse(req.params.intentId) as Hex;
  res.json(await getIntentStatusResponse(intentId));
});

intentsRouter.post("/api/intents/:intentId/settle", async (req, res) => {
  const intentId = hex32.parse(req.params.intentId) as Hex;
  const body = SettleSchema.parse(req.body);
  res.json(
    await settle({
      intentId,
      payer: body.payer as `0x${string}`,
      signature: body.signature as Hex,
      ...(body.validAfter !== undefined ? { validAfter: BigInt(body.validAfter) } : {}),
      ...(body.validBefore !== undefined ? { validBefore: BigInt(body.validBefore) } : {}),
    }),
  );
});

intentsRouter.post("/api/intents/:intentId/requote", async (req, res) => {
  const intentId = hex32.parse(req.params.intentId) as Hex;
  res.status(201).json(await requoteIntent(intentId));
});

intentsRouter.post("/api/faucet", async (req, res) => {
  const body = FaucetSchema.parse(req.body);
  res.json(await faucetMint(body.address as `0x${string}`));
});
