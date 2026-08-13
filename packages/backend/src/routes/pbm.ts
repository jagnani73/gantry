import { Router } from "express";
import { z } from "zod";
import {
  Door,
  isValidHandle,
  toWireSpendAuthorization,
  type PbmIntentResponse,
} from "@gantry/shared";
import { config } from "../config";
import { createIntent } from "../services/intents";
import { inFlightGuard } from "../services/in-flight";

/**
 * The `gantry-pbm` pre-signing step. The scheme's SpendAuthorization binds the
 * intentId, but intents are relayer-created on-chain — so the client asks for
 * one here between receiving the 402 and sending PAYMENT-SIGNATURE. The
 * returned typed data is wallet-agnostic (no verifyingContract); the client
 * revives it with its own PBM wallet address and signs with the session key.
 *
 * Known accepted vector (demo trust level, same class as the faucet): this
 * endpoint is unauthenticated and each call costs the relayer one createIntent
 * tx. Abandoned intents expire on their own (TTL 600s); no funds ever move at
 * creation.
 */
export const pbmRouter = Router();

const BodySchema = z.object({
  handle: z.string().refine(isValidHandle, "invalid merchant handle"),
  xsgdAmount: z.string().regex(/^\d+$/, "expected 6dp XSGD units as a decimal string"),
});

/** Same bound as POST /api/intents: one relayer tx per call, one nonce queue. */
const pbmIntentGuard = inFlightGuard(
  "IntentCreationInProgress",
  "an intent creation from this address is already in flight",
);

pbmRouter.post("/api/pbm/intent", async (req, res) => {
  const body = BodySchema.parse(req.body);
  // Door derived from the route, never client-supplied: this route exists
  // only for the agent scheme, so everything it creates is an Agent intent.
  const intent = await pbmIntentGuard.run(req.ip, () =>
    createIntent(
      { handle: body.handle, xsgdAmount: body.xsgdAmount, token: "USDC" as const },
      Door.Agent,
    ),
  );
  const response: PbmIntentResponse = {
    intentId: intent.intentId,
    merchantId: intent.merchantId,
    handle: intent.handle,
    tokenIn: intent.tokenIn,
    tokenSymbol: intent.tokenSymbol,
    amountIn: intent.amountIn,
    xsgdAmount: intent.xsgdAmount,
    expiry: intent.expiry,
    typedData: toWireSpendAuthorization({
      chainId: config.chainId,
      intentId: intent.intentId,
      token: intent.tokenIn,
      amount: BigInt(intent.amountIn),
    }),
    txHash: intent.txHash,
  };
  res.status(201).json(response);
});
