import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_SEPOLIA_ADDRESSES } from "@gantry/shared";

const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(agentRoot, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

/**
 * The session key lives HERE and is touched only inside pay-flow.ts signing.
 * It never appears in tool inputs/outputs, so it structurally cannot reach
 * the LLM.
 */
export const env = {
  gantryApi: process.env.GANTRY_API ?? "http://localhost:4000",
  agentSessionKey: process.env.AGENT_SESSION_KEY as `0x${string}` | undefined,
  pbmWallet: (process.env.PBM_WALLET_ADDRESS ??
    BASE_SEPOLIA_ADDRESSES.demoAgentPbmWallet ??
    undefined) as `0x${string}` | undefined,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  llmTimeoutMs: Number(process.env.AGENT_LLM_TIMEOUT_MS ?? 8000),
} as const;

export function requireSigningEnv(): { key: `0x${string}`; wallet: `0x${string}` } {
  if (!env.agentSessionKey) {
    throw new Error("AGENT_SESSION_KEY missing — generate one and fund/authorize its wallet");
  }
  if (!env.pbmWallet) {
    throw new Error("PBM_WALLET_ADDRESS missing and no demo wallet pinned for this chain");
  }
  return { key: env.agentSessionKey, wallet: env.pbmWallet };
}
