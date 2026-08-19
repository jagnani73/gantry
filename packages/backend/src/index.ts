import { networkInterfaces } from "node:os";
import express from "express";
import cors from "cors";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER } from "@gantry/shared";
import { config } from "./config";
import { assertTokenDomains, relayerAccount } from "./chain";
import { errorMiddleware } from "./errors";
import { startIndexer } from "./indexer";
import { healthRouter } from "./routes/health";
import { merchantsRouter } from "./routes/merchants";
import { intentsRouter } from "./routes/intents";
import { eventsRouter } from "./routes/events";
import { settlementsRouter } from "./routes/settlements";
import { denialsRouter } from "./routes/denials";
import { agentsRouter } from "./routes/agents";
import { adminRouter } from "./routes/admin";
import { facilitatorRouter } from "./routes/facilitator";
import { pbmRouter } from "./routes/pbm";
import { ordersRouter, payLinkRouter } from "./routes/order";
import { x402Middleware } from "./x402";
import { installLogRedaction, registerSecrets } from "./redact";

// Before anything can log. The RPC key is in the URL PATH, and viem prints the
// URL in a transport error's metaMessages and in every `[cause]` chain that
// reaches console — see redact.ts. config.ts itself never logs a URL, so its
// import-time output above is already safe.
registerSecrets([...config.rpcUrls, config.wsUrl]);
installLogRedaction();

const app = express();

// Behind Railway/Fly TLS termination the 402's resource.url must say https —
// clients echo and pin that URL.
app.set("trust proxy", 1);
app.use(
  cors({
    origin: config.corsOrigin === "*" ? true : config.corsOrigin,
    // The whole x402 conversation rides in two custom headers, and CORS hides
    // those from browser JS unless they are named here: without this a page can
    // see the 402 status and cannot read the bill, which is every field that
    // matters. Any browser-based x402 client needs this, not just ours.
    exposedHeaders: [PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER],
  }),
);
app.use(express.json());

app.use(healthRouter);
app.use(merchantsRouter);
app.use(intentsRouter);
app.use(eventsRouter);
app.use(settlementsRouter);
app.use(denialsRouter);
app.use(agentsRouter);
app.use(adminRouter);
app.use(facilitatorRouter);
app.use(pbmRouter);
// The pay link's human half, and it MUST sit above the middleware: a browser
// has no way to pay a 402, so it is peeled off and redirected to the payer app
// before the challenge is ever built. Everything else falls through.
app.use(payLinkRouter);
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
    // Announce it: the demo-account payer flow dies without the faucet, and
    // "demo host or not" is otherwise invisible until a payer is already waiting
    // on the funding step. BOTH ceilings, because the faucet has two legs that
    // refuse independently — an unannounced gas ceiling turns "your agent could
    // not be armed" into a mystery on the one host nobody is watching the logs of.
    console.log(
      config.hostClass === "demo"
        ? "demo host: payer faucet unmetered on both legs, self-service onboarding ON"
        : `public host: payer faucet capped at ${config.faucetDailyBudget} USDC units and ` +
            `${config.faucetEthDailyBudget} wei/24h across all addresses; self-service ` +
            "onboarding OFF — only merchants already on-chain are served",
    );
    // A public host derives nothing from the request host — that is the open
    // redirect guard — so without APP_URL the pay link's human half 500s. Said
    // at boot because the alternative is discovering it from a payer.
    if (!config.appUrl && config.hostClass === "public") {
      console.warn("APP_URL unset: /pay/:handle cannot send a browser to the payer app on this host");
    }
    for (const ip of lanAddresses()) console.log(`  LAN: http://${ip}:${config.port}`);
  });
  await startIndexer();
}

main().catch((err) => {
  console.error("backend failed to start:", err);
  process.exit(1);
});
