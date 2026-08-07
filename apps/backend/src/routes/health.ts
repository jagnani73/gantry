import { Router } from "express";
import type { HealthResponse } from "@gantry/shared";
import { publicClient, relayerAccount } from "../chain";
import { getCursor } from "../db";
import { config } from "../config";

export const healthRouter = Router();

healthRouter.get("/health", async (_req, res) => {
  const block = await publicClient.getBlockNumber();
  const body: HealthResponse = {
    ok: true,
    chainId: config.chainId,
    block: Number(block),
    relayer: relayerAccount.address,
    indexerCursor: Number(getCursor() ?? config.deployBlock),
    onboardingEnabled: config.onboardingEnabled,
  };
  res.json(body);
});
