// Put a book on a fresh core: one real settlement of every flow this rail has.
//
// `pnpm contracts:fresh` gives you a new GantryCore, and a new core has no
// history — every merchant feed, every payer activity list, every payouts
// breakdown and the whole denial surface render empty, because they are swept
// from chain events that do not exist yet. There is deliberately no way to
// import the old ones (see "THERE IS NO RESET" in CLAUDE.md): the rows ARE the
// chain, so the only honest way to have data is to make some.
//
// This runs the flows rather than reimplementing them. Each line below is a
// command from the sign-off gate, already tested and already exit-code gated,
// so a seed run doubles as a full regression pass over the fresh deployment —
// which is the thing you actually want to know after a redeploy.
//
// WHAT IT CANNOT DO. Block timestamps are real, so nothing here can be
// backdated: every row lands today. The Overview's rolling 7-day tiles will
// show a single day, Payouts "By day" will have one row, and the whole
// Transactions feed reads "Today". Faking a spread would mean inventing a
// blockTime, and a product whose thesis is "the chain is the record" does not
// get to invent one.
//
// NOT part of `demo:reset`, and it must not become part of it. That script runs
// before every rehearsal against a 30-second budget; this one sends a dozen real
// transactions and takes minutes. `demo:reset` provisions the STATE a rehearsal
// needs; this writes HISTORY, once, after a redeploy.
//
// Order, after `pnpm contracts:fresh`:
//   pnpm abis && git commit … && restart the backend   (addresses are read at boot)
//   pnpm demo:reset                                    (shops, agent, funds)
//   pnpm demo:seed                                     (this)
//
// Usage: pnpm demo:seed [--dry-run]
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Same three env files demo-reset loads, and for the same reasons: the demo
// payer's key lives in the web env, the agent's signer in the agent env, and
// everything else in the backend's.
for (const envFile of [
  resolve(repoRoot, "packages/backend/.env"),
  resolve(repoRoot, "packages/web/.env.local"),
  resolve(repoRoot, "packages/agent/.env"),
]) {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: { "dry-run": { type: "boolean", default: false } },
});
const dryRun = args["dry-run"];

const { BASE_SEPOLIA_ADDRESSES } = await import("../packages/shared/src/addresses.ts");
const { DEMO_MERCHANT_HANDLE, DEMO_POLICY, DEMO_RATE_EURC } = await import(
  "../packages/shared/src/constants.ts"
);
const { agentPbmWalletAbi } = await import("../packages/shared/src/abis/agentPbmWallet.ts");
const { agentPbmWalletFactoryAbi } = await import(
  "../packages/shared/src/abis/agentPbmWalletFactory.ts"
);

// viem out of the backend's tree, exactly as demo-reset does it: `scripts/` is
// not a workspace package, so a bare `import "viem"` does not resolve, and a
// second declared copy could drift from the one the backend pins.
const requireFromBackend = createRequire(resolve(repoRoot, "packages/backend/package.json"));
const importFromBackend = (specifier) =>
  import(pathToFileURL(requireFromBackend.resolve(specifier)).href);
const { createPublicClient, createWalletClient, erc20Abi, fallback, formatUnits, http, parseEventLogs } =
  await importFromBackend("viem");
const { privateKeyToAccount } = await importFromBackend("viem/accounts");
const { baseSepolia } = await importFromBackend("viem/chains");

function requireKey(name, where) {
  const value = process.env[name];
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    console.error(`${name} missing or malformed (expected 0x + 64 hex chars, in ${where})`);
    process.exit(1);
  }
  return value;
}

const payerKey = requireKey("NEXT_PUBLIC_DEMO_KEY", "packages/web/.env.local");
const payer = privateKeyToAccount(payerKey);
const agentSigner = privateKeyToAccount(
  requireKey("AGENT_SESSION_KEY", "packages/agent/.env"),
).address;

const PUBLIC_BASE_SEPOLIA_RPC = "https://sepolia.base.org";
const rpcUrls = (process.env.BASE_SEPOLIA_RPC_URL ?? "")
  .split(",")
  .map((url) => url.trim())
  .filter((url) => url.length > 0);
if (!rpcUrls.includes(PUBLIC_BASE_SEPOLIA_RPC)) rpcUrls.push(PUBLIC_BASE_SEPOLIA_RPC);
const transport = () => fallback(rpcUrls.map((url) => http(url)));
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: transport(),
  pollingInterval: 500,
});
const payerClient = createWalletClient({ chain: baseSepolia, account: payer, transport: transport() });

const backend = process.env.GANTRY_API ?? "http://localhost:4000";
const RECEIPT_TIMEOUT_MS = 20_000;

/** Simulate-before-send, like every write path in this repo: an ownership or
 * policy revert is decoded here rather than burned as a failed transaction. */
async function payerTx(params) {
  const { request } = await publicClient.simulateContract({ account: payer, ...params });
  const hash = await payerClient.writeContract(request);
  return publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
}

async function get(path) {
  try {
    const res = await fetch(`${backend}${path}`);
    return { res, body: res.ok ? await res.json().catch(() => null) : null };
  } catch {
    return { res: null, body: null };
  }
}

const eur = (units) => `${Number(formatUnits(BigInt(units), 6)).toFixed(6)} EURC`;

// ─────────────────────────────────────────────────────── preconditions

// All of these are `demo:reset`'s job. Checked rather than assumed because each
// one fails LATE and confusingly otherwise: an unregistered shop surfaces as a
// 404 inside a payment, and a missing agent wallet as "no PBM wallet lists this
// signer" three flows in, after real money has already moved.
const problems = [];

const health = await get("/health");
if (!health.res?.ok || !health.body) {
  console.error(`backend unreachable at ${backend} — start it, or set GANTRY_API`);
  process.exit(1);
}
if (health.body.chainId !== baseSepolia.id) {
  problems.push(`backend is on chain ${health.body.chainId}, expected ${baseSepolia.id}`);
}

const merchants = await get("/api/merchants");
const handles = new Set((merchants.body?.merchants ?? []).map((m) => m.handle));
for (const handle of [DEMO_MERCHANT_HANDLE, "gadgethub-sg"]) {
  if (!handles.has(handle)) problems.push(`merchant "${handle}" is not registered`);
}

const agents = await get(`/api/agents?owner=${payer.address}&agentSigner=${agentSigner}`);
if (!agents.res?.ok) {
  problems.push("could not list the payer's agent wallets");
} else if ((agents.body?.agents ?? []).length === 0) {
  problems.push("the payer owns no agent wallet for this signer");
}

if (problems.length > 0) {
  console.error("cannot seed:");
  for (const problem of problems) console.error(`  · ${problem}`);
  console.error("\nRun `pnpm demo:reset` first — it registers the shops and provisions the agent.");
  process.exit(1);
}

// ─────────────────────────────────────────────────────── the flow runner

/**
 * @param drop Env vars to REMOVE from the child's environment.
 *
 * Load-bearing, not tidiness. This script loads `packages/backend/.env`, which
 * may pin `E2E_PAYER_KEY` / `X402_PAYER_KEY` — and those scripts use a pinned
 * key when they see one and generate a fresh funded burner when they do not.
 * Inheriting a pin silently collapses every "different payer" row onto one
 * address, which is the one thing the burner runs exist to avoid.
 */
function run(label, command, { env = {}, drop = [] } = {}) {
  const childEnv = { ...process.env, ...env };
  for (const key of drop) delete childEnv[key];
  console.log(`\n──── ${label}\n     ${command}`);
  if (dryRun) return { label, ok: true, skipped: true };
  const started = Date.now();
  const result = spawnSync(command, { cwd: repoRoot, stdio: "inherit", shell: true, env: childEnv });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = result.status === 0;
  console.log(`     ${ok ? "ok" : `FAILED (exit ${result.status})`} in ${seconds}s`);
  return { label, ok, seconds };
}

const BURNER = ["E2E_PAYER_KEY", "X402_PAYER_KEY"];
const results = [];

// ─────────────────────────────────────────────────────── human door

// Signed by the DEMO payer, so the payer app has history of its own: /app
// filters activity on the connected address, and on a deployed build every
// visitor signs as this account. Seeded entirely with burners, that surface
// stays empty while the merchant's looks healthy.
results.push(
  run("human door · dollars · demo payer", `pnpm --filter @gantry/backend e2e:pay -- --sgd 1.50`, {
    env: { E2E_PAYER_KEY: payerKey },
  }),
);
results.push(
  run(
    "human door · euros · demo payer",
    `pnpm --filter @gantry/backend e2e:pay -- --sgd 1.50 --token EURC`,
    { env: { E2E_PAYER_KEY: payerKey } },
  ),
);
// A burner, and the second shop — so the directory has two merchants with real
// takings rather than one shop and one placeholder.
results.push(
  run(
    "human door · dollars · gadgethub-sg",
    `pnpm --filter @gantry/backend e2e:pay -- --sgd 1.20 --handle gadgethub-sg`,
    { drop: BURNER },
  ),
);

// ─────────────────────────────────────────────────────── agent door (USDC)

// BEFORE the euro wallet exists. Selection is currency-first so it would resolve
// correctly either way, but ordering costs nothing and removes the question.
results.push(run("agent door · dollars", `pnpm --filter @gantry/agent e2e:pbm -- --sgd 1.50`));
// The refusal. Cheap on purpose: it is inside every cap the wallet has, so the
// only thing that can stop it is the category — "the amount was fine, the
// category wasn't". It moves no money and writes an IntentDenied row.
results.push(
  run(
    "agent door · refused (CategoryNotAllowed)",
    `pnpm --filter @gantry/agent e2e:pbm -- --handle gadgethub-sg --sgd 1.00 --expect-denial`,
  ),
);

// ─────────────────────────────────────────────────────── standards door

// Every one a fresh burner: these are the rows that prove a stranger's client
// can pay us, and they should not all be the same stranger.
results.push(
  run("x402 exact · dollars", `pnpm --filter @gantry/backend x402:buy -- --sgd 1.00`, {
    drop: BURNER,
  }),
);
results.push(
  run("x402 exact · euros", `pnpm --filter @gantry/backend x402:buy -- --sgd 1.00 --token EURC`, {
    drop: BURNER,
  }),
);
results.push(
  run("dual-door pay link", `pnpm --filter @gantry/backend x402:buy -- --sgd 1.00 --link`, {
    drop: BURNER,
  }),
);
results.push(
  run("discovery → pay a listing", `pnpm --filter @gantry/backend x402:buy -- --sgd 1.00 --discover`, {
    drop: BURNER,
  }),
);

// ─────────────────────────────────────────────────────── agent door (EURC)

/**
 * A euro agent is a SECOND wallet, because one currency per agent is a contract
 * constraint: `Policy` holds a single `dailyCap`, a single `perTxCap` and a
 * single `_spentToday`, all in one token's units, so a wallet holding both
 * counts €1 as $1.
 *
 * Funded by the PAYER, not by the relayer and not by `/api/admin/wallet/topup`.
 * Two reasons. `topUpPbmWallet` funds the token a wallet ALREADY holds, and an
 * empty wallet resolves to the default — so it would send dollars to the wallet
 * that is supposed to be the euro one. And demo-reset's rule applies here too:
 * the relayer's nonce belongs to the backend's FIFO queue, and this script runs
 * while that queue is busy settling, so it must not sign as the relayer.
 * Agent wallets are payer-owned, so the payer funding its own is also the
 * honest shape.
 */
const EURO_LABEL = "Euro Runner";
const EURO_FLOAT = 2_000_000n; // 2.000000 EURC — one S$1.50 spend (0.993378) with room

let euroWallet = null;
let euroNote = null;
{
  const listed = await get(`/api/agents?owner=${payer.address}&agentSigner=${agentSigner}`);
  // Idempotent: re-running the seed must not mint a second euro wallet. Nothing
  // can ever delete one, so a duplicate is permanent clutter on the agents
  // screen and one more candidate for the CLI to choose between.
  euroWallet = (listed.body?.agents ?? []).find((a) => a.token === "EURC")?.wallet ?? null;

  if (euroWallet) {
    euroNote = `reused ${euroWallet}`;
  } else if (dryRun) {
    euroNote = "would create, fund and arm a euro wallet";
  } else {
    try {
      const payerEurc = await publicClient.readContract({
        address: BASE_SEPOLIA_ADDRESSES.realEurc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [payer.address],
      });
      if (payerEurc < EURO_FLOAT) {
        throw new Error(
          `payer holds ${eur(payerEurc)}, needs ${eur(EURO_FLOAT)} to float the wallet. ` +
            `EURC cannot be bought on this testnet — top the relayer up at https://faucet.circle.com ` +
            `and re-run demo:reset`,
        );
      }

      const created = await payerTx({
        address: BASE_SEPOLIA_ADDRESSES.agentPbmFactory,
        abi: agentPbmWalletFactoryAbi,
        functionName: "createWallet",
        args: [agentSigner, EURO_LABEL],
      });
      // From the LOG, never the simulation: the factory uses CREATE, so the
      // address depends on its nonce at MINING time.
      const [event] = parseEventLogs({
        abi: agentPbmWalletFactoryAbi,
        eventName: "WalletCreated",
        logs: created.logs,
      });
      if (!event?.args?.wallet) {
        throw new Error(
          `createWallet mined in ${created.transactionHash} but carried no WalletCreated log; ` +
            `a wallet may exist, so re-run rather than creating another`,
        );
      }
      euroWallet = event.args.wallet;

      // Fund BEFORE arming, so the wallet's derived currency is EURC by the time
      // anything reads it. An unfunded wallet reports the default token, and the
      // agent CLI selects currency-first.
      await payerTx({
        address: BASE_SEPOLIA_ADDRESSES.realEurc,
        abi: erc20Abi,
        functionName: "transfer",
        args: [euroWallet, EURO_FLOAT],
      });

      // Caps in EURC units, not the USDC figures. DEMO_POLICY's 37,255,049 is
      // S$50 at 1.3421; the same number of euro units would be S$56, so the
      // agents screen would state a cap the payer never chose. Ceil-quoted at
      // the euro rate, the same arithmetic the relayer prices with.
      const euroCap = (BigInt(50_000_000) * 1_000_000n + DEMO_RATE_EURC - 1n) / DEMO_RATE_EURC;
      const block = await publicClient.getBlock();
      await payerTx({
        address: euroWallet,
        abi: agentPbmWalletAbi,
        functionName: "setPolicy",
        args: [
          {
            dailyCap: euroCap,
            perTxCap: euroCap,
            expiry: Number(block.timestamp) + DEMO_POLICY.policyTtlSeconds,
            categoryBitmap: DEMO_POLICY.categoryBitmap,
          },
        ],
      });
      euroNote = `created ${euroWallet}, floated ${eur(EURO_FLOAT)}, armed`;
    } catch (err) {
      euroNote = `FAILED — ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

if (euroWallet) {
  // BOTH pins. `AGENT_PAY_TOKEN` picks the currency and `AGENT_WALLET` names the
  // wallet: two wallets now list this signer, and `createWallet` takes
  // `agentSigner` unproven, so discovery alone is exactly what the pin exists to
  // replace.
  results.push(
    run("agent door · euros", `pnpm --filter @gantry/agent e2e:pbm -- --sgd 1.50`, {
      env: { AGENT_PAY_TOKEN: "EURC", AGENT_WALLET: euroWallet },
    }),
  );
} else {
  results.push({ label: "agent door · euros", ok: false, note: euroNote });
}

// ─────────────────────────────────────────────────────── report

console.log("\n────────────────────────────────────────────");
console.log(`euro agent  ${euroNote ?? "—"}`);
console.log("");
for (const result of results) {
  const mark = result.skipped ? "·" : result.ok ? "✓" : "✗";
  console.log(`${mark} ${result.label}${result.note ? `  ${result.note}` : ""}`);
}

const failed = results.filter((r) => !r.ok);
console.log("");
if (dryRun) {
  console.log("dry run — nothing was sent.");
} else if (failed.length === 0) {
  console.log(`${results.length} flows settled. The book is no longer empty.`);
  console.log("Every row is dated TODAY — block timestamps are real and cannot be backdated,");
  console.log("so the Overview's 7-day tiles and the Payouts day breakdown will show one day.");
} else {
  console.log(`${failed.length} of ${results.length} flows FAILED — the book is partial.`);
  console.log("Re-running is safe: nothing here is idempotent-unsafe except the euro");
  console.log("wallet, which is reused when it already exists.");
}
// Non-zero on any failure, so this can gate a post-redeploy check the way the
// sign-off gate does. Exit code, not output: a pipe to `tail` hides the rest.
process.exitCode = failed.length === 0 ? 0 : 1;
