import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  BASE_SEPOLIA_ADDRESSES,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_DEPLOY_BLOCK,
} from "@gantry/shared";
import { faucetCeilings } from "./services/faucet-core";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(backendRoot, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);


const EnvSchema = z.object({
  /** Comma-separated, tried in order. One URL is a valid single-entry list. */
  BASE_SEPOLIA_RPC_URL: z.string().optional(),
  BASE_SEPOLIA_WS_URL: z.string().optional(),
  RELAYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x-prefixed 32-byte key"),
  PORT: z.coerce.number().default(4000),
  /** Origin of the payer app, for the pay link's human half. OPTIONAL on
   * purpose: unset, the redirect follows the host the request arrived on, which
   * is what makes a scanned LAN link work without anyone updating an env var
   * when the laptop's IP moves. Set it on a deployed host, where the two halves
   * are different domains and no request can reveal the other one. */
  APP_URL: z.string().url().optional(),
  /** Port of the payer app, used only when APP_URL is unset. */
  APP_PORT: z.coerce.number().default(3000),
  CORS_ORIGIN: z.string().default("*"),
  ADMIN_TOKEN: z.string().min(8),
  /** Not a Gantry setting — the standard Node signal, read here so the demo
   * affordances have one thing to key off: one standard variable rather than a
   * Gantry-specific flag per affordance. NOTHING in this repo sets it — there is
   * no container image (deployment is Render's native Node build), so the
   * deployed host must set `production` itself, which is exactly why a
   * misconfiguration is warned about below rather than assumed away.
   *
   * Kept a free string because tooling sets values we do not enumerate (`test`,
   * `staging`), but ANY value other than `production` means "demo host" — so a
   * typo like `Production` or a trailing space fails OPEN, unlocking an
   * unauthenticated USDC spigot on a public box. `hostClass` below warns loudly
   * rather than silently trusting it. */
  NODE_ENV: z.string().optional(),
  /**
   * `closed` refuses self-service registration; anything else (including unset)
   * leaves it open. The kill switch for the one thing a rate limiter cannot
   * undo — a registration is permanent and its text renders on a public page —
   * so it exists to be flipped from a host dashboard during an incident, with
   * no code change and no push.
   *
   * An enum would be worse here: the safe state is OPEN (that is the product),
   * so a typo must not close the door, and the one value that closes it is
   * spelled out rather than inferred.
   */
  ONBOARDING: z.string().optional(),
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
 * One question — "is this a demo host or a public one?" — behind every affordance
 * that spends the relayer's balances without authenticating anyone. NODE_ENV
 * rather than Gantry-specific flags: there is no identity to check, only a host to
 * classify, and every deploy target already knows this variable.
 *
 * Exported as a named class, not left implicit in the derived fields. Those fields
 * carry different payloads (a ceiling and a permission) and nothing would stop
 * them drifting — the boot banner was already inferring the onboarding state from
 * the faucet's value, which would have announced "onboarding OFF" while
 * registration stayed open the moment anyone capped a demo host.
 */
export type HostClass = "demo" | "public";

const KNOWN_NODE_ENVS = ["production", "development", "test", ""];
function classifyHost(nodeEnv: string | undefined): HostClass {
  const raw = nodeEnv ?? "";
  if (raw === "production") return "public";
  if (!KNOWN_NODE_ENVS.includes(raw)) {
    // Fails open by design (anything-but-production = demo), so say so. A silent
    // `Production` typo would leave a real-USDC faucet and open merchant
    // registration on a public host.
    console.warn(
      `NODE_ENV="${raw}" is not a value we recognise — treating this as a DEMO host, ` +
        `which leaves the payer faucet unmetered and merchant registration unmetered. ` +
        `Set NODE_ENV=production if this is a public deployment.`,
    );
  }
  return "demo";
}

const hostClass = classifyHost(env.NODE_ENV);
const isDemoHost = hostClass === "demo";
/** Both faucet ceilings, decided in services/faucet-core.ts — the module that
 * also owns the grant sizes they are five of, and the only place either ceiling
 * is wired to a leg. No VALUE is re-declared here; faucet-core is the one a unit
 * test can reach, so it stays the only source. The numbers quoted in the prose
 * below explain the choice and are not read by anything. */
const faucetLimits = faucetCeilings(isDemoHost);

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
  /** Null means "derive the payer-app origin from each request" — see APP_URL. */
  appUrl: env.APP_URL ?? null,
  appPort: env.APP_PORT,
  corsOrigin: env.CORS_ORIGIN,
  adminToken: env.ADMIN_TOKEN,
  /** Ask this, never one affordance's value, to describe what the host will do. */
  hostClass,
  /**
   * Rolling-24h ceiling on payer funding across ALL addresses, or null for
   * unmetered. Reported at boot; the faucet itself reads it through
   * `createFaucetLegs`.
   *
   * The faucet transfers REAL Circle USDC out of the relayer and its cooldown is
   * per-address, so fresh addresses make the grant loop unbounded. A ceiling
   * rather than an off switch, because the pinned demo account is what lets a
   * judge scan the deck's QR and pay with no wallet of their own — switching it
   * off on the public host would make the deployed payer page unusable by
   * exactly the people it needs to impress. 20 USDC is five grants: enough for a
   * Q&A, and a loss the existing ETH→USDC top-up swap can replace. (That swap
   * spends ETH from this same key, so it is not free — see MAX_ETH_PER_SWAP in
   * services/funder.ts.)
   *
   * Unmetered on a demo host: a rehearsal pass alone spends two grants
   * (`e2e:pay` + `x402:buy`), so ten of them would blow any sane ceiling.
   */
  faucetDailyBudget: faucetLimits.usdc,
  /**
   * Rolling-24h ceiling, in WEI, on the faucet's gas leg — or null for
   * unmetered. A SECOND ceiling rather than a shared counter with the USDC one,
   * and since the two legs also hold separate cooldowns and separate entry
   * points, neither can exhaust the other NOR make it unreachable.
   *
   * Agent wallets are owned by the payer, so `createWallet`, `setPolicy` and
   * `revoke` are the payer's own transactions and a fresh key cannot send them
   * without gas. Paying a merchant is still gasless — this funds ownership, not
   * payment.
   *
   * 0.01 ETH is five full 0.002 top-ups, matching the USDC ceiling's five
   * grants, so neither leg is the loose one. The number that matters is what is
   * LEFT: this ETH is the only gas key in the system and it pays for every
   * door, so 0.01 is a fifth of the 0.05 reserve services/funder.ts already
   * refuses to swap below.
   *
   * Unmetered on a demo host, like the USDC leg — a rehearsal pass funds
   * several addresses and ten of them would blow any sane ceiling.
   */
  faucetEthDailyBudget: faucetLimits.gas,
  /**
   * Whether strangers may register merchants. OPEN everywhere since 20 Aug.
   *
   * It used to be `isDemoHost`, on the argument that onboarding spends relayer
   * ETH and draining the gas key stops every door rather than just this one.
   * That argument was weak where it mattered: this is Base Sepolia, the ETH is
   * faucet ETH, and `registerMerchant` costs ~180k gas. A rail nobody outside
   * the demo can join is also a poor demonstration of a permissionless registry
   * — `registerMerchant` needs no permission from us on-chain, and a door that
   * says otherwise off-chain was telling a story the contract does not.
   *
   * What the gate was really standing in front of is NOT gas: a registration is
   * PERMANENT and its text renders on `/merchants`, a public submission
   * artifact. Nothing can delete a handle, and `resolveProfile` rejects
   * invisible and deceptive text but has no opinion on offensive text. So the
   * replacement control is a global rolling-24h ceiling in `services/merchants`,
   * which bounds the total regardless of how many IPs a caller has — the per-IP
   * cooldown never could.
   *
   * `ONBOARDING=closed` is the kill switch, for responding to abuse without a
   * code change (a Render env edit redeploys on its own).
   */
  onboardingEnabled: env.ONBOARDING !== "closed",
  /**
   * Whether that ceiling is enforced. Unmetered on a demo host for the same
   * reason both faucet legs are: a rehearsal pass registers the canonical shops
   * repeatedly and any sane public ceiling would stop it mid-run.
   */
  onboardingMetered: !isDemoHost,
  /* The historical demo AgentPBMWallet used to be pinned here. It is gone: the
   * read path is owner-driven and answers for any wallet, the admin re-arm was
   * deleted with the rest of the server-side policy writes, and the wallet
   * top-up now takes its target as an argument. A config field naming ONE
   * wallet, in a world where payers create their own, is a default waiting to
   * be used by accident. The address survives in @gantry/shared as history. */
  /** SQLite is a disposable cache — the chain is the source of truth — so the
   * location has never needed to vary. */
  dbPath: resolve(backendRoot, "./gantry.db"),
} as const;
