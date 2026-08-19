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
  /**
   * OPTIONAL pin for the wallet this agent acts through. Discovery stays the
   * default; this exists because discovery alone cannot be made safe.
   *
   * `createWallet` is permissionless and takes `agentSigner` unproven, so anyone
   * can mint a wallet naming someone else's session key. Selection then picks
   * the NEWEST such wallet, and an attacker can always create one newer — so a
   * stranger can move which wallet an agent acts through, permanently, and the
   * policy constraining that agent silently becomes the attacker's policy
   * rather than the owner's. Nothing can delete a wallet, so it does not undo.
   *
   * Setting this makes the choice explicit and unspoofable. Left unset the CLI
   * still discovers, and says loudly when the answer was ambiguous.
   */
  agentWallet: process.env.AGENT_WALLET as `0x${string}` | undefined,
  /**
   * Pay the DUAL-DOOR pay link (`GET /pay/:handle`) instead of the agent-only
   * endpoint (`POST /api/order/:handle`).
   *
   * Both routes share one `orderAccepts` array by reference, so this changes the
   * URL and the verb and nothing else about the payment. It exists for the demo:
   * the strongest line in the script is that the agent is handed the same link
   * the tourist just opened, and that has to be literally true on the night —
   * it is a claim anyone in the room can check afterwards by opening the URL.
   *
   * Off by default, so the agent's normal path is unchanged.
   */
  usePayLink: process.env.AGENT_USE_PAY_LINK === "1",
  /**
   * Which currency this agent pays in. ONE per agent, and the constraint comes
   * from the contract: the wallet holds a single `dailyCap`, a single
   * `perTxCap` and a single `spentToday` counter, all denominated in one
   * token's units — so an agent spending two would have its euros counted as
   * dollars, about 13% adrift at the demo rates and silent about it.
   *
   * Unset means USDC, which is what every agent was before EURC existed. The
   * wallet must actually HOLD this token: the facilitator refuses a spend in a
   * token the wallet does not hold, precisely because the cap would otherwise
   * be denominated in the wrong currency without saying so.
   */
  agentPayToken: process.env.AGENT_PAY_TOKEN,
  /** Google AI Studio key (free tier). */
  googleApiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  /**
   * AIsa's OpenAI-compatible gateway. Takes precedence over Google when both
   * are set; with neither, the agent runs scripted.
   */
  aisaApiKey: process.env.AISA_API_KEY,
  aisaBaseUrl: process.env.AISA_BASE_URL ?? "https://api.aisa.one/v1",
  /**
   * Required alongside AISA_API_KEY, and deliberately NOT defaulted.
   *
   * The Google model is pinned in code because swapping it is a change with
   * prompt implications. This one cannot be: the catalog belongs to a third
   * party, the ids are not knowable without a key, and inventing a plausible
   * default buys nothing — a wrong id fails at the gateway mid-demo, whereas an
   * absent one fails at startup with a sentence saying so.
   *
   * Whatever is chosen MUST be a model with native tool calling. See the note
   * on `selectProvider` in index.ts: a gateway that answers tool calls as prose
   * does not error, it just never pays.
   */
  aisaModel: process.env.AISA_MODEL,
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
