import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  BASE_SEPOLIA_ADDRESSES,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_DEPLOY_BLOCK,
  ANVIL_CHAIN_ID,
  type GantryAddresses,
} from "@gantry/shared";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(backendRoot, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x-prefixed address");

const EnvSchema = z.object({
  CHAIN_ID: z.coerce.number().default(BASE_SEPOLIA_CHAIN_ID),
  BASE_SEPOLIA_RPC_URL: z.string().optional(),
  BASE_SEPOLIA_WS_URL: z.string().optional(),
  RPC_FALLBACK_URL: z.string().default("https://sepolia.base.org"),
  ANVIL_RPC_URL: z.string().default("http://127.0.0.1:8545"),
  RELAYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x-prefixed 32-byte key"),
  GANTRY_CORE_ADDRESS: hexAddress.optional(),
  FIXED_RATE_SWAP_ADDRESS: hexAddress.optional(),
  MOCK_USDC_ADDRESS: hexAddress.optional(),
  MOCK_XSGD_ADDRESS: hexAddress.optional(),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default("*"),
  ADMIN_TOKEN: z.string().min(8),
  FAUCET_ENABLED: z.enum(["0", "1"]).default("1"),
  INTENT_TTL_SECONDS: z.coerce.number().min(60).default(600),
  DB_PATH: z.string().default("./gantry.db"),
  DEFAULT_TOKEN: z.enum(["MUSDC", "USDC", "XSGD"]).default("MUSDC"),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid backend environment:");
  console.error(parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n"));
  process.exit(1);
}
const env = parsed.data;

function resolveAddresses(): { addresses: GantryAddresses; deployBlock: bigint } {
  if (env.CHAIN_ID === BASE_SEPOLIA_CHAIN_ID) {
    return { addresses: BASE_SEPOLIA_ADDRESSES, deployBlock: BASE_SEPOLIA_DEPLOY_BLOCK };
  }
  if (env.CHAIN_ID === ANVIL_CHAIN_ID) {
    const missing = [
      ["GANTRY_CORE_ADDRESS", env.GANTRY_CORE_ADDRESS],
      ["FIXED_RATE_SWAP_ADDRESS", env.FIXED_RATE_SWAP_ADDRESS],
      ["MOCK_USDC_ADDRESS", env.MOCK_USDC_ADDRESS],
      ["MOCK_XSGD_ADDRESS", env.MOCK_XSGD_ADDRESS],
    ].filter(([, v]) => !v);
    if (missing.length > 0) {
      console.error(
        `CHAIN_ID=31337 requires address overrides: ${missing.map(([k]) => k).join(", ")}`,
      );
      process.exit(1);
    }
    return {
      addresses: {
        gantryCore: env.GANTRY_CORE_ADDRESS as GantryAddresses["gantryCore"],
        fixedRateSwap: env.FIXED_RATE_SWAP_ADDRESS as GantryAddresses["fixedRateSwap"],
        mockUsdc: env.MOCK_USDC_ADDRESS as GantryAddresses["mockUsdc"],
        mockXsgd: env.MOCK_XSGD_ADDRESS as GantryAddresses["mockXsgd"],
        realUsdc: null,
      },
      deployBlock: 0n,
    };
  }
  console.error(`Unsupported CHAIN_ID ${env.CHAIN_ID} (expected 84532 or 31337)`);
  process.exit(1);
}

const { addresses, deployBlock } = resolveAddresses();

function requireRpcUrl(): string {
  if (env.CHAIN_ID === ANVIL_CHAIN_ID) return env.ANVIL_RPC_URL;
  if (!env.BASE_SEPOLIA_RPC_URL) {
    console.error("BASE_SEPOLIA_RPC_URL is required for CHAIN_ID=84532");
    process.exit(1);
  }
  return env.BASE_SEPOLIA_RPC_URL;
}

const rpcUrl = requireRpcUrl();
// Alchemy-style URLs share the path between https and wss.
const wsUrl =
  env.CHAIN_ID === ANVIL_CHAIN_ID
    ? env.ANVIL_RPC_URL.replace(/^http/, "ws")
    : (env.BASE_SEPOLIA_WS_URL ?? rpcUrl.replace(/^https:\/\//, "wss://"));

export const config = {
  chainId: env.CHAIN_ID,
  rpcUrl,
  wsUrl,
  rpcFallbackUrl: env.RPC_FALLBACK_URL,
  relayerPrivateKey: env.RELAYER_PRIVATE_KEY as `0x${string}`,
  addresses,
  deployBlock,
  port: env.PORT,
  corsOrigin: env.CORS_ORIGIN,
  adminToken: env.ADMIN_TOKEN,
  faucetEnabled: env.FAUCET_ENABLED === "1",
  intentTtlSeconds: env.INTENT_TTL_SECONDS,
  dbPath: resolve(backendRoot, env.DB_PATH),
  defaultToken: env.DEFAULT_TOKEN,
} as const;
