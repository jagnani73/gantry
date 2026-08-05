import { Router } from "express";
import { z } from "zod";
import type { X402PaymentPayload, X402PaymentRequirements } from "@gantry/shared";
import { settleBridge } from "../services/bridge";
import { getSupported, verifyExact } from "../services/facilitator";

/**
 * The externally-visible, spec-shaped facilitator surface (what a standard
 * x402 resource server pointed at `…/facilitator` would call). The in-process
 * middleware uses the same service functions without the HTTP hop. Payment
 * problems are ALWAYS in-band 200s (`isValid:false` / `success:false`) —
 * only malformed envelopes get a 400 via the ZodError middleware.
 */
export const facilitatorRouter = Router();

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x-prefixed address");

const RequirementsSchema = z.object({
  scheme: z.string(),
  network: z.string(),
  asset: hexAddress,
  amount: z.string().regex(/^\d+$/),
  payTo: hexAddress,
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.record(z.string(), z.unknown()),
});

const EnvelopeSchema = z.object({
  x402Version: z.literal(2),
  paymentPayload: z.object({
    x402Version: z.literal(2),
    resource: z
      .object({ url: z.string(), description: z.string().optional(), mimeType: z.string().optional() })
      .optional(),
    accepted: RequirementsSchema,
    payload: z.record(z.string(), z.unknown()),
    extensions: z.record(z.string(), z.unknown()).optional(),
  }),
  paymentRequirements: RequirementsSchema,
});

facilitatorRouter.get("/facilitator/supported", (_req, res) => {
  res.json(getSupported());
});

facilitatorRouter.post("/facilitator/verify", async (req, res) => {
  const body = EnvelopeSchema.parse(req.body);
  res.json(
    await verifyExact(
      body.paymentPayload as X402PaymentPayload,
      body.paymentRequirements as X402PaymentRequirements,
    ),
  );
});

facilitatorRouter.post("/facilitator/settle", async (req, res) => {
  const body = EnvelopeSchema.parse(req.body);
  res.json(
    await settleBridge(
      body.paymentPayload as X402PaymentPayload,
      body.paymentRequirements as X402PaymentRequirements,
    ),
  );
});
