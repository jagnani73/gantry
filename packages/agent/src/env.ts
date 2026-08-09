import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

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
  /** Google AI Studio key (free tier) — absent ⇒ scripted mode. */
  googleApiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  llmTimeoutMs: Number(process.env.AGENT_LLM_TIMEOUT_MS ?? 8000),
} as const;

/**
 * The signer, not the wallet. Wallets are created on-chain by their owner — the
 * payer — so their addresses are dynamic and cannot be a committed constant any
 * more. What this process knows is its own session key; the wallet it acts for
 * is discovered from it (see `resolveAgentWallet` in pay-flow.ts), because
 * `WalletCreated` indexes `agentSigner` and the backend can answer "which
 * wallets am I the signer for?".
 *
 * Deriving the address here also keeps the key itself inside this module and
 * the signing path, so it still cannot reach the LLM.
 */
export function requireSigningEnv(): { key: `0x${string}`; signer: `0x${string}` } {
  // Shape-check the key so a malformed one fails HERE, before any HTTP — not at
  // signing time, after an on-chain intent was already created.
  if (!env.agentSessionKey || !/^0x[0-9a-fA-F]{64}$/.test(env.agentSessionKey)) {
    throw new Error("AGENT_SESSION_KEY missing or malformed: expected 0x + 64 hex chars");
  }
  return { key: env.agentSessionKey, signer: privateKeyToAccount(env.agentSessionKey).address };
}
