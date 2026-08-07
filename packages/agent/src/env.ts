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
  /** Pinned in shared, not env: the backend verifies against the same pin, and
   * two env copies that disagree fail as InvalidAgentSignature. */
  pbmWallet: BASE_SEPOLIA_ADDRESSES.demoAgentPbmWallet,
  /** Google AI Studio key (free tier) — absent ⇒ scripted mode. */
  googleApiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  llmTimeoutMs: Number(process.env.AGENT_LLM_TIMEOUT_MS ?? 8000),
} as const;

export function requireSigningEnv(): { key: `0x${string}`; wallet: `0x${string}` } {
  // Shape-check the key so a malformed one fails HERE, before any HTTP — not at
  // signing time, after an on-chain intent was already created. The wallet needs
  // no check: it is a committed constant in @gantry/shared, not env input.
  if (!env.agentSessionKey || !/^0x[0-9a-fA-F]{64}$/.test(env.agentSessionKey)) {
    throw new Error("AGENT_SESSION_KEY missing or malformed — expected 0x + 64 hex chars");
  }
  return { key: env.agentSessionKey, wallet: env.pbmWallet };
}
