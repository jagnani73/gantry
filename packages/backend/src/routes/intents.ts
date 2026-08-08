import { Router } from "express";
import { z } from "zod";
import { TOKEN_IDS } from "@gantry/shared";
import type { Hex } from "viem";
import { createIntent, getIntentStatusResponse, requoteIntent } from "../services/intents";
import { settle } from "../services/settlement";
import { fundPayer, fundPayerGas } from "../services/faucet";

export const intentsRouter = Router();

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x-prefixed 32-byte hex");
const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x-prefixed address");

const CreateIntentSchema = z.object({
  handle: z.string(),
  xsgdAmount: z.string(),
  // Required: every caller already pins it, and a server-side default would
  // silently decide which asset a payer signs for. Derived from TOKENS so the
  // schema cannot drift from the token set.
  token: z.enum(TOKEN_IDS),
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
  res.json(await fundPayer(body.address as `0x${string}`));
});

/**
 * Gas only — for a caller that wants to SEND rather than to pay (the payer app,
 * before an `onlyOwner` agent write on an empty key).
 *
 * A separate path rather than a flag on the one above, because the two differ in
 * what may refuse them and in what a refusal MEANS. This one never touches the
 * USDC ceiling or its cooldown, so a payer holding plenty of USDC and no gas can
 * always reach it, and every error it returns is about gas. Through /api/faucet
 * that caller would spend a scarce grant to get 0.002 ETH, and hear about USDC
 * when it was refused.
 *
 * `{ txHash: null, funded: "0" }` is a success: the payer already held enough.
 */
intentsRouter.post("/api/faucet/gas", async (req, res) => {
  const body = FaucetSchema.parse(req.body);
  res.json(await fundPayerGas(body.address as `0x${string}`));
});
