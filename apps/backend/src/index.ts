import { networkInterfaces } from "node:os";
import express from "express";
import cors from "cors";
import { config } from "./config";
import { assertTokenDomains, relayerAccount } from "./chain";
import { errorMiddleware } from "./errors";
import { healthRouter } from "./routes/health";

const app = express();

app.use(cors({ origin: config.corsOrigin === "*" ? true : config.corsOrigin }));
app.use(express.json());

app.use(healthRouter);

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
    for (const ip of lanAddresses()) console.log(`  LAN: http://${ip}:${config.port}`);
  });
}

main().catch((err) => {
  console.error("backend failed to start:", err);
  process.exit(1);
});
