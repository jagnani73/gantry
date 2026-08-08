import { networkInterfaces } from "node:os";
import express from "express";
import cors from "cors";
import { config } from "./config";
import { assertTokenDomains, relayerAccount } from "./chain";
import { errorMiddleware } from "./errors";
import { startIndexer } from "./indexer";
import { healthRouter } from "./routes/health";
import { merchantsRouter } from "./routes/merchants";
import { intentsRouter } from "./routes/intents";
import { eventsRouter } from "./routes/events";
import { adminRouter } from "./routes/admin";
import { facilitatorRouter } from "./routes/facilitator";
import { pbmRouter } from "./routes/pbm";
import { policyRouter } from "./routes/policy";
import { ordersRouter } from "./routes/order";
import { x402Middleware } from "./x402";

const app = express();

// Behind Railway/Fly TLS termination the 402's resource.url must say https —
// clients echo and pin that URL.
app.set("trust proxy", 1);
app.use(cors({ origin: config.corsOrigin === "*" ? true : config.corsOrigin }));
app.use(express.json());

app.use(healthRouter);
app.use(merchantsRouter);
app.use(intentsRouter);
app.use(eventsRouter);
app.use(adminRouter);
app.use(facilitatorRouter);
app.use(pbmRouter);
app.use(policyRouter);
// The x402 middleware must wrap the order route: it 402-challenges unpaid
// requests and only lets verified ones through to the handler below.
app.use(x402Middleware);
app.use(ordersRouter);

app.use(errorMiddleware);

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address);
}

async function main() {
  await assertTokenDomains();
  app.listen(config.port, "0.0.0.0", () => {
    console.log(`gantry backend on :${config.port} (chain ${config.chainId})`);
    console.log(`relayer: ${relayerAccount.address}`);
    // Announce it: burner mode dies without the faucet, and "demo host or not"
    // is otherwise invisible until a payer is already waiting on the funding step.
    console.log(
      config.demoFundingEnabled
        ? "demo host: payer faucet ON (relayer transfers real USDC)"
        : "public host: payer faucet OFF (NODE_ENV=production) — burner mode will not fund",
    );
    for (const ip of lanAddresses()) console.log(`  LAN: http://${ip}:${config.port}`);
  });
  await startIndexer();
}

main().catch((err) => {
  console.error("backend failed to start:", err);
  process.exit(1);
});
