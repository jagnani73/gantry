// One-command demo PROVISIONING: money, merchants and the agent's policy. It
// does NOT touch the transaction feed and cannot — every mechanism for that was
// per-host state, which is precisely what made this laptop and the deployed
// backend show different books while indexing the same chain from the same
// block. A clean book is a fresh core: `pnpm contracts:fresh`.
//
// The name is kept because it is in the demo script and in muscle memory. These
// numbers ARE the `// 1.` … `// 7.` markers in the file, deliberately — "step
// 6b" is cross-referenced from here and from services/agents.ts, so a header
// that counted differently would name a different step:
//   1. tops the FUNDER up — this can execute a real three-transaction Uniswap v3
//      ETH→USDC swap, so this script spends real balances, not just state
//   2. funds the demo PAYER (USDC to pay with, ETH to sign its own owner txs)
//   3. registers the two canonical merchant shops on-chain, display text included
//   4. finds or CREATES the payer's agent wallet (a real contract deployment)
//   5. tops that wallet up (a real USDC transfer)
//   6. re-arms its policy on-chain (setPolicy, resets spentToday)
//  6b. confirms the agent CLI would resolve the SAME wallet this run armed
//   7. checks gadgethub-sg, then prints the cheat sheet
// Chain state (merchants, contracts, listed swap rate) is reused — Sepolia
// redeploys are not needed per rehearsal. Exits non-zero if any step degraded.
//
// ORDERING. Two dependencies decide it, and both run opposite to how the steps
// read:
//   * The funder is the SUPPLY and everything else is a CONSUMER of it. The
//     faucet sends 4 USDC + a gas top-up and the wallet top-up sends up to 10,
//     both out of the relayer's balance, and both fail hard when it is empty —
//     so refilling the funder afterwards "fixes" it one step too late and the
//     rehearsal runs underfunded anyway. Funder first, always.
//   * Agent wallets are owned by the PAYER now, so `createWallet` and
//     `setPolicy` are the payer's own transactions signed with the payer's own
//     key. A key with no ETH cannot send them, so the payer must be funded
//     before the wallet exists, and the wallet must exist before it can be
//     topped up or armed.
// Merchant registration sits between the two halves because it depends on
// neither — it is the relayer's own transaction, funded by step 1 — and doing it
// early means the cheat sheet names the right shops even if a later step
// degrades. It is a no-op on every run but the first against a fresh core.
//
// Usage: pnpm demo:reset
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// packages/agent/.env is loaded for AGENT_SESSION_KEY: the agent's signer
// address is an INPUT to createWallet, and the CLI finds its wallet by asking
// which ones list that signer. Provision against a different key and the agent
// resolves nothing.
for (const envFile of [
  resolve(repoRoot, "packages/backend/.env"),
  resolve(repoRoot, "packages/web/.env.local"),
  resolve(repoRoot, "packages/agent/.env"),
]) {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

// Node ≥22.18 (or ≥23.6) strips TS types natively, so the shared source imports
// directly. Only modules with no runtime dependency of their own are reachable
// this way — `scripts/` is not a workspace package, so a bare `import "viem"`
// would not resolve from here.
const { BASE_SEPOLIA_ADDRESSES, BASE_SEPOLIA_RELAYER } = await import(
  "../packages/shared/src/addresses.ts"
);
const { DEMO_MERCHANTS, DEMO_MERCHANT_HANDLE, DEMO_POLICY } = await import(
  "../packages/shared/src/constants.ts"
);
const { gantryCoreAbi } = await import("../packages/shared/src/abis/gantryCore.ts");
const { agentPbmWalletAbi } = await import("../packages/shared/src/abis/agentPbmWallet.ts");
const { agentPbmWalletFactoryAbi } = await import(
  "../packages/shared/src/abis/agentPbmWalletFactory.ts"
);

/**
 * viem, borrowed from the backend's dependency tree rather than added to the
 * root package.json. This script signs two transactions with the demo payer's
 * key — `createWallet` and `setPolicy` are `onlyOwner` and the owner is the
 * payer, so no server route can do it — and resolving the package the backend
 * already pins is the smallest way to get a signer here without a second
 * declared copy of viem that could drift from it.
 */
const requireFromBackend = createRequire(resolve(repoRoot, "packages/backend/package.json"));
const importFromBackend = (specifier) =>
  import(pathToFileURL(requireFromBackend.resolve(specifier)).href);
const {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  fallback,
  formatEther,
  formatUnits,
  http,
  keccak256,
  parseEventLogs,
  toHex,
} = await importFromBackend("viem");
const { privateKeyToAccount } = await importFromBackend("viem/accounts");
const { baseSepolia } = await importFromBackend("viem/chains");

/**
 * Deliberately localhost, NOT NEXT_PUBLIC_BACKEND_URL. That variable exists so a
 * PHONE can reach this laptop, so it holds a LAN IP — which changes whenever the
 * laptop joins a different network, and then `demo:reset` starts failing to talk
 * to a backend running on the same machine. This script always runs beside the
 * backend, so the loopback address is both correct and stable.
 */
const backend = `http://localhost:${process.env.PORT ?? 4000}`;
/** The printed URLs DO want the LAN address — that is what the phone scans. */
const app = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) {
  console.error("ADMIN_TOKEN not found (expected in packages/backend/.env)");
  process.exit(1);
}

/**
 * Keys are CONFIG, so they fail here rather than degrading a run — a reset that
 * cannot sign is a reset that arms nothing. Only the derived ADDRESSES are ever
 * printed; the keys themselves never leave this file.
 */
function requireKey(name, where) {
  const value = process.env[name];
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    console.error(`${name} missing or malformed (expected 0x + 64 hex chars, in ${where})`);
    process.exit(1);
  }
  return value;
}
const payer = privateKeyToAccount(requireKey("NEXT_PUBLIC_DEMO_KEY", "packages/web/.env.local"));
const agentSigner = privateKeyToAccount(
  requireKey("AGENT_SESSION_KEY", "packages/agent/.env"),
).address;

/** Same ordered fallback the backend builds, and for the same reason: ranking is
 * off, so failover happens only on a real error. The public node is appended as
 * a last resort exactly as config.ts does. */
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
  // viem's 4s default would add up to four seconds of pure waiting to each of
  // the three receipts below, on a chain that produces a block every two.
  pollingInterval: 500,
});
const payerClient = createWalletClient({ chain: baseSepolia, account: payer, transport: transport() });
/** The demo shops' payout address. Derived rather than hardcoded so it cannot
 * drift from whichever relayer key this machine actually holds — but the key
 * itself never signs here: every relayer write goes through the backend's queue,
 * which owns the nonce. */
const relayerAddress = privateKeyToAccount(
  requireKey("RELAYER_PRIVATE_KEY", "packages/backend/.env"),
).address;

/** Matches the relayer's own 20s cap. A timeout does NOT prove the transaction
 * did not land (the repo's compensation invariant), so every caller reports it
 * as unresolved rather than re-sending. */
const RECEIPT_TIMEOUT_MS = 20_000;

/**
 * The same reading of "can this wallet spend" as `agentStatus` in
 * @gantry/shared, which is unreachable from here: it imports "./time" without a
 * file extension, and node's type stripping does not rewrite specifiers — only
 * shared modules with no relative imports of their own load in this script.
 * Kept deliberately identical: expiry 0 is revoked (that is what `revoked` is
 * derived from), an expiry in the past is lapsed, and `now === expiry` still
 * spends because authorizeSpend reverts on `block.timestamp > expiry`.
 */
const isActive = (agent, now) =>
  Number.isFinite(agent.expiry) && agent.expiry > 0 && now <= agent.expiry;

/** Simulate-before-send, like every write path in the backend: a policy or
 * ownership revert is decoded here, before a transaction is broadcast. */
async function payerTx(params) {
  const { request } = await publicClient.simulateContract({ account: payer, ...params });
  const hash = await payerClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
  if (receipt.status !== "success") {
    throw new Error(`${params.functionName} reverted on-chain in ${receipt.transactionHash}`);
  }
  return receipt;
}

const started = Date.now();

// This script does NOT clear the transaction feed, and no longer can — the
// route that did is gone. Clearing was per-host state, so it made this laptop
// show a different book from the deployed backend indexing the same chain.
// A clean book is a fresh core: `pnpm contracts:fresh`.
//
// Guarded like every other call below: an unreachable backend should say so in
// one line, not dump an undici stack trace as the first thing an operator sees.
const healthRes = await fetch(`${backend}/health`).catch((err) => {
  console.error(`cannot reach the backend at ${backend} (${err instanceof Error ? err.message : err}). Is \`pnpm dev\` running?`);
  process.exit(1);
});
// `process.exit` inside the catch above terminates before this line, so a
// rejection never reaches here — only a real HTTP status can.
if (!healthRes.ok) {
  console.error(`health check failed: ${healthRes.status}`);
  process.exit(1);
}
// A 200 carrying non-JSON is a captive portal or a proxy, not our backend. The
// promise this file makes is one line rather than a raw undici stack trace, and
// a top-level `await res.json()` throwing would break it at the first step.
const health = await healthRes.json().catch(() => null);
if (!health?.indexer) {
  console.error(`${backend}/health returned 200 but not our health payload — captive portal or wrong URL?`);
  process.exit(1);
}

/**
 * Prove the admin token BEFORE anything spends. The deleted reset call was the
 * first request to carry `x-admin-token`, so a rotated or typo'd one used to
 * stop this script in its first second. Without a probe the failure scatters:
 * step 1 401s, steps 4-6 still send the payer's OWN transactions (a contract
 * deployment and a policy write, real gas), and step 3 loses its operator
 * cooldown exemption so the second shop 429s and reports as a registration
 * failure rather than an auth one. Four confusing warnings and spent gas,
 * thirty seconds apart, instead of one line for free.
 *
 * `wallet/topup` with no body is the cheap probe: it checks the token first and
 * refuses the missing address with a 400, so a 401 here means the token and
 * nothing else.
 */
const authProbe = await fetch(`${backend}/api/admin/wallet/topup`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-admin-token": adminToken },
  body: "{}",
}).catch(() => null);
if (authProbe?.status === 401) {
  console.error("ADMIN_TOKEN is set but the backend rejects it (401). Check packages/backend/.env.");
  process.exit(1);
}

let degraded = false;

/** Every network call from here on is best-effort: a flake must not crash the
 * script after money has moved, because the cheat sheet below is the whole point
 * of running it. */
async function call(method, path, json) {
  try {
    const res = await fetch(`${backend}${path}`, {
      method,
      headers: {
        "x-admin-token": adminToken,
        ...(json === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    return { res, body: res.ok ? await res.json().catch(() => null) : await res.text().catch(() => "") };
  } catch (err) {
    return { res: null, body: err instanceof Error ? err.message : String(err) };
  }
}
const post = (path, json) => call("POST", path, json);

/** Server bodies land in one-line summaries an operator scans before going on
 * stage; an unbounded HTML error page would bury every other line. */
const brief = (value, max = 140) => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
const why = (res, body) => (res ? `${res.status}: ${brief(body)}` : brief(body));
const usd = (units) => `${Number(formatUnits(BigInt(units), 6)).toFixed(2)} USDC`;
const eur = (units) => `${Number(formatUnits(BigInt(units), 6)).toFixed(2)} EURC`;

// 1. Funder: reports ETH/USDC/WETH and swaps ETH for USDC when USDC runs low.
//    First, because every step below spends what it holds.
let funderLine;
{
  const { res, body } = await post("/api/admin/funder/topup");
  if (res?.ok && body) {
    funderLine =
      `funder   ${body.funder}  ${Number(body.eth).toFixed(4)} ETH · ${Number(body.usdc).toFixed(2)} USDC` +
      (Number(body.weth) > 0 ? ` · ⚠ ${Number(body.weth).toFixed(4)} WETH stranded` : "") +
      (body.swapped ? `
         ↳ ${body.detail}` : "");
  } else {
    degraded = true;
    funderLine = `⚠ funder  ${BASE_SEPOLIA_RELAYER}  top-up failed (${why(res, body)}); every door spends this key`;
  }
}

// 2. Payer: needs USDC to pay with AND ETH, because configuring an agent is an
//    owner action it now signs itself. Called only when a balance is actually
//    short — the USDC leg is a flat grant out of a finite testnet balance, and
//    the faucet's own 60s per-address cooldown would turn a second reset inside
//    a minute into a warning about a payer that is already funded. What gets
//    REPORTED is the post-state read off the chain, never the grant we asked
//    for: the arithmetic is exact only if nothing else touched the address.
/** One full faucet grant — sized in services/faucet-core.ts (`GRANT`) to cover
 * the largest single payment a funded payer makes (the payer page's S$5
 * demo-account cap ≈ 3.73 USDC). */
const PAYER_USDC_FLOOR = 4_000_000n;
/** Half the faucet's 0.002 ETH target: below this, one `createWallet` (a
 * contract deployment) plus a couple of `setPolicy` calls gets tight. */
const PAYER_ETH_FLOOR = 1_000_000_000_000_000n;

/** The rehearsal wallet's on-chain name. Must fit `AgentPBMWallet`'s 31-BYTE
 * label bound — 11 ASCII bytes here, with plenty of room. */
const DEMO_AGENT_LABEL = "Kopi Runner";

/** The rehearsal agent pays in USDC. A wallet holding another payable token is
 * a different agent with its own caps, and must not be provisioned as this one. */
const DEMO_AGENT_TOKEN = "USDC";

async function payerBalances() {
  const [eth, usdc] = await Promise.all([
    publicClient.getBalance({ address: payer.address }),
    publicClient.readContract({
      address: BASE_SEPOLIA_ADDRESSES.realUsdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [payer.address],
    }),
  ]);
  return { eth, usdc };
}

/**
 * Enough for one euro payment at the payer page's S$5 demo cap.
 *
 * That cap ceil-quotes to 3_311_259 at 1.51, so a 3_000_000 floor passed a
 * payer who then could not sign the largest amount the page offers. Matched to
 * the faucet's own EURC grant (3_400_000), which is sized from the same cap.
 */
const PAYER_EURC_FLOOR = 3_311_259n;

const eurcBalanceOf = (address) =>
  publicClient.readContract({
    address: BASE_SEPOLIA_ADDRESSES.realEurc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });

let payerLine;
{
  let unreadable = null;
  const read = async () =>
    payerBalances().catch((err) => {
      unreadable = brief(err instanceof Error ? err.message : String(err));
      return null;
    });

  let balances = await read();
  let faucet = null;
  if (!balances || balances.usdc < PAYER_USDC_FLOOR || balances.eth < PAYER_ETH_FLOOR) {
    const { res, body } = await post("/api/faucet", { address: payer.address });
    faucet = res?.ok && body ? `faucet +${usd(body.funded)}` : `faucet ${why(res, body)}`;
    balances = await read();
  }
  if (!balances) {
    degraded = true;
    payerLine =
      `⚠ payer   ${payer.address}  balances unreadable (${unreadable}); cannot tell whether it ` +
      `can sign the owner transactions the steps below depend on`;
  } else if (balances.usdc < PAYER_USDC_FLOOR || balances.eth < PAYER_ETH_FLOOR) {
    degraded = true;
    payerLine =
      `⚠ payer   ${payer.address}  ${usd(balances.usdc)} · ${formatEther(balances.eth)} ETH. ` +
      `Still short (${faucet ?? "not funded"}); createWallet/setPolicy need gas and the QR beat needs USDC`;
  } else {
    payerLine =
      `payer    ${payer.address}  ${usd(balances.usdc)} · ${Number(formatEther(balances.eth)).toFixed(4)} ETH` +
      (faucet === null ? "" : ` (${faucet})`);
  }
}

/**
 * The euro half of "any currency in".
 *
 * Reported but never `degraded`: the demo spine is the USDC path and it is
 * unaffected by an empty EURC balance. What must not happen is silence — a
 * presenter switching the payer app to euros and discovering an empty wallet
 * mid-demo is exactly the failure this line exists to pre-empt.
 *
 * The relayer is the source (the faucet transfers, it cannot mint Circle's
 * token), so a shortfall here is a human errand: fund the relayer from Circle's
 * faucet at https://faucet.circle.com.
 */
let eurcLine;
{
  try {
    const [payerEurc, relayerEurc] = await Promise.all([
      eurcBalanceOf(payer.address),
      eurcBalanceOf(BASE_SEPOLIA_RELAYER),
    ]);
    let topped = null;
    let refusal = null;
    if (payerEurc < PAYER_EURC_FLOOR && relayerEurc >= PAYER_EURC_FLOOR) {
      const { res, body } = await post("/api/faucet", { address: payer.address, token: "EURC" });
      if (res?.ok && body) {
        topped = `faucet +${eur(body.funded)}`;
      } else {
        // KEPT, not discarded. Step 2 already granted this address USDC seconds
        // ago and the token leg's per-address cooldown is 60s regardless of host
        // class, so the ordinary refusal here is our OWN cooldown — and the
        // shortfall line used to drop this and blame Circle instead, sending an
        // operator to an external faucet while the relayer was full.
        refusal = why(res, body);
        topped = `faucet ${refusal}`;
      }
    }
    const after = await eurcBalanceOf(payer.address);
    const remedy =
      refusal === null
        ? `Relayer holds ${eur(relayerEurc)}; top it up at https://faucet.circle.com.`
        : `The grant was refused (${refusal}) — relayer holds ${eur(relayerEurc)}, so if that is a ` +
          `cooldown from step 2's USDC grant, wait a minute and re-run.`;
    eurcLine =
      after >= PAYER_EURC_FLOOR
        ? `payer    ${eur(after)} for the euro beat${topped === null ? "" : ` (${topped})`}`
        : `⚠ payer   ${eur(after)} — the euro beat needs ${eur(PAYER_EURC_FLOOR)}. ` +
          `${remedy} The USDC path is unaffected.`;
  } catch (err) {
    eurcLine = `⚠ payer   EURC balance unreadable (${brief(err instanceof Error ? err.message : String(err))})`;
  }
}

// 3. The demo shops, registered ON-CHAIN with their display text. Since 11 Aug
//    2026 the name, location and blurb live in the merchant record, so this is
//    one transaction per shop instead of a registration followed by a PATCH —
//    and a shop can no longer exist unnamed, because there is no second write to
//    fail after the handle is claimed.
//
//    Posted THROUGH the backend, with the admin token. It is tempting to sign
//    this here — the script already holds the relayer key — and that is exactly
//    what must not happen: `relayer.ts` keeps the nonce in module state, so a
//    second signer on that key picks a nonce from a lagging `pending` count and
//    the transaction that loses the replacement race is a settlement. The 30s
//    per-IP cooldown that made direct signing tempting is waived for an operator.
let profileLine;
{
  const done = [];
  const failed = [];
  for (const [handle, shop] of Object.entries(DEMO_MERCHANTS)) {
    const id = keccak256(toHex(handle));
    const registered = async () => {
      const [payout] = await publicClient.readContract({
        address: BASE_SEPOLIA_ADDRESSES.gantryCore,
        abi: gantryCoreAbi,
        functionName: "merchants",
        args: [id],
      });
      return payout !== "0x0000000000000000000000000000000000000000";
    };
    try {
      if (await registered()) {
        done.push(shop.displayName);
        continue;
      }
      const { res, body } = await call("POST", "/api/merchants", {
        handle,
        payout: relayerAddress,
        categoryId: shop.categoryId,
        displayName: shop.displayName,
        location: shop.location,
        blurb: shop.blurb,
      });
      if (res?.ok) {
        done.push(`${shop.displayName} (registered)`);
        continue;
      }
      // A refusal is not proof it did not land: the route waits on a receipt and
      // the relayer caps that at 20s. Ask the chain before saying so.
      if (await registered()) {
        done.push(`${shop.displayName} (registered, slow receipt)`);
      } else {
        failed.push(`${handle} (${why(res, body)})`);
      }
    } catch (err) {
      failed.push(`${handle} (${brief(err instanceof Error ? err.message : String(err))})`);
    }
  }
  if (failed.length === 0) {
    profileLine = `merchants ${done.join(" · ")}`;
  } else {
    degraded = true;
    profileLine = `⚠ merchant registration failed for ${failed.join(", ")}; those shops will not resolve`;
  }
}

// 4. The agent wallet, provisioned on demand. There is no committed wallet
//    address any more: wallets are created by their payer-owner through the
//    permissionless factory, so the honest question is "which one does this
//    payer own for this signer". Filtered on BOTH, because a wallet the payer
//    owns that lists some other signer is one the CLI could never spend from,
//    and creating a second is cheaper than debugging that on stage.
let wallet = null;
let walletCreated = false;
/** Everything that went wrong across steps 4-6, so the agent line can be one
 * line that either wears a checkmark or does not. Appending a "⚠ top-up FAILED"
 * fragment to an otherwise healthy line would put a warning under a checkmark. */
const walletProblems = [];
/** What the chain says AFTER the arm — never a restatement of what was sent. */
let armed = null;
{
  const { res, body } = await call(
    "GET",
    `/api/agents?owner=${payer.address}&agentSigner=${agentSigner}`,
  );
  if (!res?.ok || !body) {
    degraded = true;
    walletProblems.push(`lookup failed (${why(res, body)}); nothing was created, funded or armed`);
  } else if (body.agents.length > 0) {
    // The SAME rule step 6b checks and the agent CLI applies — newest active
    // first. Taking `agents[0]` here was a second, silently different rule: with
    // two wallets for one signer it funds and arms the OLDEST while 6b blesses
    // the newest, so the script would arm one wallet, report another, and the
    // agent would spend from a third state entirely. One rule, stated once.
    // CURRENCY FIRST, then newest-active — the same rule the agent CLI applies.
    // An agent wallet spends one token, so a euro wallet cannot run the USDC
    // beats at all; picking it because it happened to be newest is how this
    // script would provision the wrong agent and report it with a checkmark.
    const now = Math.floor(Date.now() / 1000);
    const pool = body.agents.filter((agent) => agent.token === DEMO_AGENT_TOKEN);
    const candidates = pool.length > 0 ? pool : body.agents;
    const active = candidates.filter((agent) => isActive(agent, now));
    wallet = (active.at(-1) ?? candidates.at(-1)).wallet;
  } else {
    try {
      const receipt = await payerTx({
        address: BASE_SEPOLIA_ADDRESSES.agentPbmFactory,
        abi: agentPbmWalletFactoryAbi,
        functionName: "createWallet",
        // The label is on-chain and set at creation, so the rehearsal wallet
        // arrives already named — the agents screen reads "Kopi Runner" rather
        // than a hex address, with no second transaction and nothing to type.
        //
        // Only on THIS branch, deliberately. A wallet that already exists keeps
        // whatever its owner named it: renaming is a separate `setLabel`
        // transaction, and a reset that quietly overwrote a payer's own name for
        // their agent would be doing something no step here is allowed to do.
        args: [agentSigner, DEMO_AGENT_LABEL],
      });
      // The address comes from the LOG, not from the simulation's return value:
      // the factory uses CREATE, so the address depends on the factory's nonce
      // at MINING time and a simulation against pending state is a guess that
      // another creation landing first would invalidate.
      const [created] = parseEventLogs({
        abi: agentPbmWalletFactoryAbi,
        eventName: "WalletCreated",
        logs: receipt.logs,
      });
      if (created?.args?.wallet) {
        wallet = created.args.wallet;
        walletCreated = true;
      } else {
        degraded = true;
        walletProblems.push(
          `createWallet mined in ${receipt.transactionHash} but carried no WalletCreated log. ` +
            `A wallet may exist, so re-run before creating another`,
        );
      }
    } catch (err) {
      degraded = true;
      walletProblems.push(
        `createWallet failed (${brief(err instanceof Error ? err.message : String(err))}); the payer ` +
          `owns no agent wallet, so both agent beats die at "no PBM wallet lists this signer"`,
      );
    }
  }
}

// 5. Wallet top-up: enough for the drinks order AND the rejection attempt, whose
//    facilitator balance pre-check runs BEFORE the on-chain policy check.
//    Deliberately not nested under a successful policy arm — they touch
//    different resources, and a wallet left underfunded makes the S$4 GadgetHub
//    beat die as insufficient_funds instead of CategoryNotAllowed, which is the
//    wrong story entirely.
let sentLine = null;
if (wallet) {
  const { res, body } = await post("/api/admin/wallet/topup", { wallet });
  if (res?.ok && body) {
    if (body.sent !== "0") sentLine = `+${Number(body.sent).toFixed(2)} sent`;
  } else {
    degraded = true;
    walletProblems.push(`top-up FAILED (${why(res, body)}); the rejection beat will die as insufficient_funds`);
  }
}

/**
 * The armed policy, read back off the chain rather than restated from what was
 * sent — with the same bounded lag retry the facilitator and the wallet top-up
 * already carry. A read issued straight after a CONFIRMED transaction can land
 * on a replica that has not seen it yet, and here that reported "S$0.00/day ·
 * no categories" for a wallet that was correctly armed: a cheat sheet saying
 * the agent cannot spend, one line under the arm that proved it can. Observed
 * on the very first live run, so this is a real path, not a hypothetical.
 */
const READBACK_RETRIES = 5;
const READBACK_DELAY_MS = 800;
/**
 * `spentToday` is part of the freshness test, not just the daily cap.
 * `setPolicy` zeroes the counter, so ANY non-zero read after a confirmed arm is
 * definitionally stale — and it was the one field slipping through: a run right
 * after a rehearsal printed "spent S$4.50" off a lagging replica while the chain
 * said 0. That is the same class of lie the retry exists for, and the more
 * expensive one, because a presenter reads it as "the reset did not take" and
 * budgets the rehearsal around a cap that is not actually consumed.
 */
const armedHere = (body) =>
  body?.dailyCap === DEMO_POLICY.dailyCap.toString() && body?.spentToday === "0";
async function readArmedPolicy() {
  let result = await call("GET", `/api/agents/${wallet}`);
  for (let attempt = 0; attempt < READBACK_RETRIES && !armedHere(result.body); attempt++) {
    await delay(READBACK_DELAY_MS);
    result = await call("GET", `/api/agents/${wallet}`);
  }
  return result;
}

// 6. Policy: setPolicy resets the wallet's spentToday counter, so ten S$4.50
//    rehearsals never pile into the S$50/day cap. Signed by the PAYER — the
//    wallet is theirs, `setPolicy` is `onlyOwner`, and no server key can write
//    it any more. Expiry comes from CHAIN time: a laptop clock minutes ahead
//    would arm a policy that is already dead.
if (wallet) {
  try {
    const block = await publicClient.getBlock();
    await payerTx({
      address: wallet,
      abi: agentPbmWalletAbi,
      functionName: "setPolicy",
      args: [
        {
          dailyCap: DEMO_POLICY.dailyCap,
          perTxCap: DEMO_POLICY.perTxCap,
          expiry: Number(block.timestamp) + DEMO_POLICY.policyTtlSeconds,
          categoryBitmap: DEMO_POLICY.categoryBitmap,
        },
      ],
    });
    const { res, body } = await readArmedPolicy();
    if (res?.ok && body) {
      const sgd = (units) => (Number(BigInt(units) * BigInt(body.rate)) / 1e12).toFixed(2);
      armed =
        `S$${sgd(body.dailyCap)}/day · ${body.categories.join(", ")} · ` +
        `spent S$${sgd(body.spentToday)} · ${usd(body.balance)}`;
      if (!armedHere(body)) {
        // A confirmed setPolicy and a wallet that does not report it is not lag
        // any more — it is a wallet whose policy is not what this run armed.
        degraded = true;
        walletProblems.push(`setPolicy confirmed but the wallet still reads ${armed}. Re-read it before rehearsing`);
        armed = null;
      }
    } else {
      degraded = true;
      // The arm LANDED — do not claim the policy is missing; the readback flaked.
      walletProblems.push(
        `policy armed but readback failed (${why(res, body)}). Verify GET /api/agents/${wallet} manually`,
      );
    }
  } catch (err) {
    degraded = true;
    walletProblems.push(
      `setPolicy FAILED (${brief(err instanceof Error ? err.message : String(err))}); ` +
        `spentToday accumulates across rehearsals`,
    );
  }
}

const walletLine =
  walletProblems.length > 0
    ? `⚠ agent    ${wallet ?? "not provisioned"}  ${walletProblems.join(" · ")}` +
      (armed ? ` · armed ${armed}` : "")
    : `agent    ${wallet}${walletCreated ? " (created)" : ""}  ${armed}` +
      (sentLine ? ` (${sentLine})` : "");

// 6b. Which wallet will the agent ACTUALLY use? The CLI knows only its session
//     key: it asks for every wallet listing that signer and takes the NEWEST
//     ACTIVE one (packages/agent/src/pay-flow.ts). Several wallets can list this
//     signer — the factory is permissionless and nothing deletes a wallet, so
//     any payer creating a second agent for the same key adds one. (The older
//     reason, a migration from a relayer-owned wallet to a payer-owned one, no
//     longer applies: the 10 Aug 2026 factory redeploy left those wallets
//     unenumerable, so they cannot be candidates. The check stands on the first
//     reason alone.) This check must mirror that selection EXACTLY: if the two rules ever
//     drift, the script blesses a wallet the agent will not spend from, which is
//     worse than not checking at all. Checked rather than assumed because the
//     mismatch looks healthy from both ends — the CLI spends from a wallet this
//     script no longer funds or arms, while the payer app, which lists by owner,
//     shows a cap meter that never moves.
let signerLine = null;
if (wallet) {
  const { res, body } = await call("GET", `/api/agents?agentSigner=${agentSigner}`);
  if (res?.ok && body) {
    // Mirrors the CLI exactly, currency filter included. Without it this check
    // reports a false mismatch the moment a second wallet in another currency
    // exists — which is a warning that trains a presenter to ignore warnings.
    const now = Math.floor(Date.now() / 1000);
    const pool = body.agents.filter((agent) => agent.token === DEMO_AGENT_TOKEN);
    const candidates = pool.length > 0 ? pool : body.agents;
    const active = candidates.filter((agent) => isActive(agent, now));
    const chosen = active.at(-1) ?? candidates.at(-1);
    if (chosen && chosen.wallet.toLowerCase() !== wallet.toLowerCase()) {
      degraded = true;
      signerLine =
        `⚠ the agent CLI would spend from ${chosen.wallet}, NOT the wallet armed above\n` +
        `  (owner ${chosen.owner}). It is newer and active, so it wins.\n` +
        `  Either arm that one instead, or revoke it from its owner's key so this run's wallet is\n` +
        `  the newest active one for the signer.`;
    } else if (body.agents.length > 1) {
      signerLine =
        `agent CLI resolves to the same wallet (${body.agents.length} list this signer; ` +
        `the newest active ${DEMO_AGENT_TOKEN} one wins)`;
    }
  } else {
    degraded = true;
    signerLine = `⚠ could not confirm which wallet the agent CLI resolves for its signer (${why(res, body)})`;
  }
}

// 7. The rejection beat needs gadgethub-sg registered on-chain. A non-404 is NOT
//    evidence of absence — an RPC failure surfaces as a 500 here, and reporting
//    that as "not registered" sends the operator to re-register a live merchant.
let gadgetLine;
{
  const gadget = await fetch(`${backend}/api/merchants/gadgethub-sg`).catch(() => null);
  if (gadget?.ok) {
    gadgetLine = "gadgethub-sg registered (category electronics, the rejection beat)";
  } else if (gadget?.status === 404) {
    degraded = true;
    gadgetLine = "⚠ gadgethub-sg NOT registered on-chain; the rejection beat will fail";
  } else {
    degraded = true;
    gadgetLine = `⚠ could not verify gadgethub-sg (${gadget ? `status ${gadget.status}` : "network error"}); registration state UNKNOWN`;
  }
}

/** A warning must never wear a checkmark. The old template hardcoded `✓ ${line}`
 * and rendered "✓ ⚠ policy re-arm failed" on the one screen an operator scans
 * before going on stage. */
const mark = (line) => (line.startsWith("⚠") ? line : `✓ ${line}`);

/**
 * The indexer line is GRADED, not decorated — and this is the one check that
 * says a payment will actually reach the dashboard.
 *
 * It used to be free: the deleted reset route awaited `getBlockNumber()`, so a
 * dead RPC path failed this script in its first second. `/health` deliberately
 * makes no RPC call, so on its own it proves only that Express is listening.
 * `lag` is null until the first successful head read, and grows when head reads
 * succeed while the `getLogs` chunks do not — the documented Alchemy-10-block /
 * shared-egress-IP failure. Both must refuse the checkmark.
 *
 * Re-read at the end rather than reusing the boot probe: that one was taken
 * before ~30s of on-chain work, so its numbers are stale by the time they print.
 */
const finalHealth = await fetch(`${backend}/health`)
  .then((res) => (res.ok ? res.json() : null))
  .catch(() => null);
const lag = finalHealth?.indexer?.lag ?? null;
const headAt = finalHealth?.indexer?.headAt ?? null;
const headStale = headAt !== null && Math.floor(Date.now() / 1000) - headAt > 60;
let indexerLine;
if (!finalHealth) {
  degraded = true;
  indexerLine = "⚠ could not re-read /health; indexer state UNKNOWN";
} else if (lag === null) {
  degraded = true;
  indexerLine = "⚠ indexer has NEVER read a chain head (RPC path down) — the live feed will show nothing";
} else if (lag > 100 || headStale) {
  degraded = true;
  indexerLine = `⚠ indexer ${lag} blocks behind${headStale ? ", head read stale" : ""} — payments will NOT reach the dashboard`;
} else {
  indexerLine = `indexer cursor ${finalHealth.indexer.cursor}, lag ${lag} (chain ${finalHealth.chainId})`;
}

console.log(`${mark(indexerLine)}
${mark(payerLine)}
${mark(eurcLine)}
${mark(profileLine)}
${mark(walletLine)}${signerLine ? `\n${signerLine}` : ""}
${mark(gadgetLine)}
${mark(funderLine)}

contracts (Base Sepolia)
  GantryCore     ${BASE_SEPOLIA_ADDRESSES.gantryCore}
  FixedRateSwap  ${BASE_SEPOLIA_ADDRESSES.fixedRateSwap}
  MockXSGD       ${BASE_SEPOLIA_ADDRESSES.mockXsgd}
  Circle USDC    ${BASE_SEPOLIA_ADDRESSES.realUsdc}
  PBM factory    ${BASE_SEPOLIA_ADDRESSES.agentPbmFactory}
  PBM wallet     ${wallet ?? "none (not provisioned this run)"}

demo urls
  merchant   ${app}/merchant/${DEMO_MERCHANT_HANDLE}/overview
  payer app  ${app}/app
  pay link   ${app}/pay/${DEMO_MERCHANT_HANDLE}
  print QR   ${app}/qr/${DEMO_MERCHANT_HANDLE}

agent beats
  drinks     pnpm --filter @gantry/agent start "buy 3 iced teas for the team (S\\$4.50) from Ah Hock"
  rejection  pnpm --filter @gantry/agent start "buy a S\\$4 phone cable at GadgetHub"
  e2e        pnpm --filter @gantry/agent e2e:pbm [-- --handle gadgethub-sg --sgd 4 --expect-denial]

done in ${((Date.now() - started) / 1000).toFixed(1)}s`);

// Exit code asserts the outcome, matching the convention e2e-pbm.ts documents —
// the pre-rehearsal script was the one thing that could not be gated on. The
// cheat sheet prints first: it is why the script exists, and a degraded run still
// needs it.
if (degraded) {
  console.error("\n⚠ demo-reset finished DEGRADED. Fix the warnings above before rehearsing.");
  process.exit(1);
}
