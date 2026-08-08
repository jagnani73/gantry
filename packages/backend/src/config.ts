import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  BASE_SEPOLIA_ADDRESSES,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_DEPLOY_BLOCK,
} from "@gantry/shared";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(backendRoot, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);


const EnvSchema = z.object({
  /** Comma-separated, tried in order. One URL is a valid single-entry list. */
  BASE_SEPOLIA_RPC_URL: z.string().optional(),
  BASE_SEPOLIA_WS_URL: z.string().optional(),
  RELAYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x-prefixed 32-byte key"),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default("*"),
  ADMIN_TOKEN: z.string().min(8),
  /** Gates the browser-triggered POST /api/policy/revoke — a denial risk, not a
   * spend one: an open revoke lets anyone zero the agent's policy, and only the
   * admin token can re-arm it. */
  POLICY_ADMIN_ENABLED: z.enum(["0", "1"]).default("1"),
  /** Not a Gantry setting — the standard Node signal, read here so the demo
   * affordances have one thing to key off. The backend Dockerfile sets it to
   * `production`, so a deployed host disables them without remembering a flag. */
  NODE_ENV: z.string().optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid backend environment:");
  console.error(parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n"));
  process.exit(1);
}
const env = parsed.data;

/** Quote lifetime, measured from block timestamp. The signed authorization
 * window is this + 120s (bounds the accepted raw-sig front-run). Fixed: it has
 * never been varied, and a demo-length quote is a product decision, not config. */
export const INTENT_TTL_SECONDS = 600;

/** Last-resort public node, always appended so a single-provider outage on a
 * venue hotspot cannot take the whole demo down. */
const PUBLIC_BASE_SEPOLIA_RPC = "https://sepolia.base.org";

/**
 * BASE_SEPOLIA_RPC_URL is a comma-separated list, tried in order — viem's
 * fallback transport walks it on failure. A single URL is a valid one-entry
 * list. The FIRST entry is the primary: it is the one the WebSocket URL is
 * derived from, and the one viem prefers while it is healthy (ranking is
 * deliberately off — a demo should fail over only on a real error, never drift
 * to a slower public node mid-payment).
 */
function requireRpcUrls(): string[] {
  const urls = (env.BASE_SEPOLIA_RPC_URL ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  if (urls.length === 0) {
    console.error("BASE_SEPOLIA_RPC_URL is required (comma-separated for fallbacks)");
    process.exit(1);
  }
  if (!urls.includes(PUBLIC_BASE_SEPOLIA_RPC)) urls.push(PUBLIC_BASE_SEPOLIA_RPC);
  return urls;
}

/**
 * One question — "is this a demo host or a public one?" — behind the two
 * affordances that spend the relayer's balances without authenticating anyone.
 * NODE_ENV rather than Gantry-specific flags: there is no identity to check,
 * only a host to classify, and the backend Dockerfile already sets it.
 */
const isDemoHost = env.NODE_ENV !== "production";

const rpcUrls = requireRpcUrls();
const rpcUrl = rpcUrls[0]!;
// Alchemy-style URLs share the path between https and wss.
const wsUrl = env.BASE_SEPOLIA_WS_URL ?? rpcUrl.replace(/^https:\/\//, "wss://");

export const config = {
  chainId: BASE_SEPOLIA_CHAIN_ID,
  /** Primary RPC — first entry of rpcUrls; the WS URL derives from it. */
  rpcUrl,
  /** Full ordered fallback chain, primary first. */
  rpcUrls,
  wsUrl,
  relayerPrivateKey: env.RELAYER_PRIVATE_KEY as `0x${string}`,
  addresses: BASE_SEPOLIA_ADDRESSES,
  deployBlock: BASE_SEPOLIA_DEPLOY_BLOCK,
  port: env.PORT,
  corsOrigin: env.CORS_ORIGIN,
  adminToken: env.ADMIN_TOKEN,
  policyAdminEnabled: env.POLICY_ADMIN_ENABLED === "1",
  /**
   * Rolling-24h ceiling on payer funding across ALL addresses, or null for
   * unmetered.
   *
   * The faucet transfers REAL Circle USDC out of the relayer and its cooldown is
   * per-address, so fresh addresses make the grant loop unbounded. A ceiling
   * rather than an off switch, because burner mode is what lets a judge scan the
   * deck's QR and pay with no wallet at all — switching it off on the public
   * host would make the deployed payer page unusable by exactly the people it
   * needs to impress. 20 USDC is five grants: enough for a Q&A, and a loss the
   * existing ETH→USDC top-up swap absorbs without touching the gas key.
   *
   * Unmetered on a demo host: a rehearsal pass alone spends two grants
   * (`e2e:pay` + `x402:buy`), so ten of them would blow any sane ceiling.
   */
  faucetDailyBudget: isDemoHost ? null : 20_000_000n,
  /**
   * Whether strangers may register merchants. Same key, different resource:
   * onboarding spends relayer ETH per call and permanently claims a handle,
   * and its cooldown is per-IP, which bounds one browser rather than one
   * attacker. Draining the gas key stops every door, not just onboarding.
   *
   * Off in production is also the more honest product position: real merchant
   * acquiring is underwritten, never self-service. Self-registration is the
   * demo affordance; a deployed host serves the merchants already on-chain.
   */
  onboardingEnabled: isDemoHost,
  /** The demo AgentPBMWallet the policy routes read/manage. Pinned in shared
   * like every other contract address — one committed source all three
   * runtimes read, rather than per-process env copies that must agree. */
  demoPbmWallet: BASE_SEPOLIA_ADDRESSES.demoAgentPbmWallet,
  /** SQLite is a disposable cache — the chain is the source of truth — so the
   * location has never needed to vary. */
  dbPath: resolve(backendRoot, "./gantry.db"),
} as const;
