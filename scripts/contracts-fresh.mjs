/**
 * Redeploy the whole rail and repoint the repo at it.
 *
 * Deliberately NOT part of `demo:reset`. That script has a <30s budget because
 * the budget is what makes rehearsing repeatable, and it runs minutes before a
 * demo; deploying four contracts and waiting on Basescan is minutes on its own,
 * and redeploying contracts just before a demo is the riskiest thing anyone
 * could automate. This is the rare, deliberate one: run it, commit what it
 * writes, then `pnpm demo:reset` for rehearsal state.
 *
 * ORDER IS THE DESIGN. Everything that can refuse runs BEFORE anything
 * irreversible: a missing binary, an unusable key or a relayer mismatch has to
 * stop the run while it is still free. Only then does step 1 move funds, and
 * only then does step 2 spend gas.
 *
 *   0. preconditions — forge, keys, and that the deployer IS the backend's relayer
 *   1. sweep USDC out of every agent wallet this redeploy will orphan
 *   2. broadcast DeployAll
 *   3. pin the addresses and the deploy block into shared (verification after,
 *      because a Basescan hiccup must never cost the record of what was deployed)
 *   4. drop the local cache, whose cursor and agent wallets belong to the old chain
 *
 * Usage: pnpm contracts:fresh [--skip-verify] [--skip-sweep] [--yes]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractsDir = resolve(repoRoot, "packages/contracts");
const addressesFile = resolve(repoRoot, "packages/shared/src/addresses.ts");
const startedAt = Date.now();
/** Set when the deploy SUCCEEDED but the host was left in a state that must be
 * fixed by hand. Reported at the end and reflected in the exit code, because a
 * warning twenty lines above the address table is a warning nobody reads. */
let degraded = false;

const flag = (name) => process.argv.includes(name);
const die = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

// packages/contracts/.env FIRST. `loadEnvFile` never overwrites an already-set
// variable, and BASE_SEPOLIA_RPC_URL means two different things in two files:
// the backend's is a comma-separated fallback chain, the contracts' is a SINGLE
// url because foundry cannot parse the CSV form. Loading the backend first would
// silently hand forge the CSV — and it would fail after the sweep had run.
for (const envFile of [
  resolve(repoRoot, "packages/contracts/.env"),
  resolve(repoRoot, "packages/backend/.env"),
  resolve(repoRoot, "packages/web/.env.local"),
]) {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

const requireFromBackend = createRequire(resolve(repoRoot, "packages/backend/package.json"));
const importFromBackend = (specifier) =>
  import(pathToFileURL(requireFromBackend.resolve(specifier)).href);
const { createPublicClient, createWalletClient, erc20Abi, fallback, formatUnits, getAddress, http } =
  await importFromBackend("viem");
const { privateKeyToAccount } = await importFromBackend("viem/accounts");
const { baseSepolia } = await importFromBackend("viem/chains");

const { BASE_SEPOLIA_ADDRESSES, BASE_SEPOLIA_RELAYER, BASE_SEPOLIA_RETIRED_FACTORIES } =
  await import("../packages/shared/src/addresses.ts");
const { agentPbmWalletFactoryAbi } = await import(
  "../packages/shared/src/abis/agentPbmWalletFactory.ts"
);

// ------------------------------------------------------------ 0. preconditions

/** forge, resolved BEFORE anything irreversible. It is routinely absent from
 * PATH (it installs to ~/.foundry/bin), and `execFileSync` failing to find it
 * after the sweep would strand every wallet's funds for a typo. `shell: true`
 * because on Windows the binary is a .cmd shim that execFile cannot resolve. */
const forge = (args, opts = {}) =>
  execFileSync("forge", args, { cwd: contractsDir, stdio: "inherit", shell: true, ...opts });
for (const bin of ["forge", "cast"]) {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore", shell: true });
  } catch {
    // `cast` matters as much as `forge`: the verification step encodes constructor
    // args with it, and that runs AFTER the deploy — so a missing binary there
    // would fail on work that cannot be undone rather than work that has not begun.
    die(`\`${bin}\` is not runnable. Install Foundry, or add ~/.foundry/bin to PATH, and re-run.`);
  }
}

const deployKey = process.env.PRIVATE_KEY;
if (!deployKey || !/^0x[0-9a-fA-F]{64}$/.test(deployKey)) {
  die("PRIVATE_KEY missing or malformed in packages/contracts/.env — nothing can be deployed.");
}
const deployer = privateKeyToAccount(deployKey);

// The constructor takes the relayer as a parameter and DeployAll passes the
// deployer, so this key silently becomes the new core's onlyRelayer. A mismatch
// means every createIntent reverts NotRelayer — discovered mid-rehearsal, on a
// core that cannot be repointed.
if (deployer.address.toLowerCase() !== BASE_SEPOLIA_RELAYER.toLowerCase()) {
  die(
    `the deploy key is ${deployer.address} but the backend's relayer is ${BASE_SEPOLIA_RELAYER}. ` +
      "The deployer becomes the new core's onlyRelayer, so these must match.",
  );
}
if (!flag("--skip-verify") && !process.env.ETHERSCAN_API_KEY) {
  die("ETHERSCAN_API_KEY is not set. Set it, or pass --skip-verify and verify later.");
}

if (!existsSync(resolve(contractsDir, "script/DeployAll.s.sol"))) {
  die("packages/contracts/script/DeployAll.s.sol is missing.");
}

const PUBLIC_RPC = "https://sepolia.base.org";
const urls = (process.env.BASE_SEPOLIA_RPC_URL ?? "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
if (!urls.includes(PUBLIC_RPC)) urls.push(PUBLIC_RPC);
/** forge takes ONE url; viem takes the chain. Passed explicitly rather than left
 * to `foundry.toml`'s `${BASE_SEPOLIA_RPC_URL}`, so the two consumers cannot
 * disagree about what that variable means. */
const forgeRpc = urls[0];
const transport = () => fallback(urls.map((u) => http(u)));
const publicClient = createPublicClient({ chain: baseSepolia, transport: transport(), pollingInterval: 500 });

if (!flag("--yes")) {
  console.log("This REPLACES every contract. All registered merchants and agent wallets are");
  console.log("left behind, and every deployed host points at dead contracts until it rebuilds.");
  console.log(`  deployer ${deployer.address}`);
  console.log(`  rpc      ${forgeRpc}`);
  console.log("Ctrl-C within 5s to abort, or re-run with --yes to skip this wait.");
  await delay(5_000);
}

// ------------------------------------------------------------------- 1. sweep

const walletAbi = [
  {
    type: "function",
    name: "withdraw",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
];

/** Both keys that can own an agent wallet: the payer creates them from the app,
 * and the relayer owns anything the historical deploy scripts made. */
const owners = [];
for (const [name, where] of [
  ["NEXT_PUBLIC_DEMO_KEY", "packages/web/.env.local"],
  ["RELAYER_PRIVATE_KEY", "packages/backend/.env"],
]) {
  const value = process.env[name];
  // An ABSENT key warns as loudly as a malformed one. Silence here meant the
  // wallets that key owns were never listed, "recovered 0.0 USDC" printed like a
  // clean no-op, and their real USDC was orphaned by the next step.
  if (!value) {
    console.warn(`! ${name} (${where}) is not set — any wallet it owns keeps its funds forever`);
    continue;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    console.warn(`! ${name} (${where}) is malformed — its wallets will not be swept`);
    continue;
  }
  owners.push({ name, account: privateKeyToAccount(value) });
}

if (!flag("--skip-sweep")) {
  if (owners.length === 0) {
    die("no owner keys resolved, so nothing can be swept. Fix the keys, or pass --skip-sweep.");
  }
  console.log("1. sweeping USDC out of wallets this redeploy will orphan");
  let recovered = 0n;
  const stuck = [];
  // EVERY factory this project has had, not just the one being replaced.
  // `walletsOf` answers only for the factory asked, so a wallet from a superseded
  // one is reachable by address and by nothing else — and a sweep that skipped or
  // failed in some earlier redeploy left its funds exactly there.
  const factories = [BASE_SEPOLIA_ADDRESSES.agentPbmFactory, ...BASE_SEPOLIA_RETIRED_FACTORIES];
  for (const { name, account } of owners) {
    const wallets = [];
    for (const factory of factories) {
      try {
        wallets.push(
          ...(await publicClient.readContract({
            address: factory,
            abi: agentPbmWalletFactoryAbi,
            functionName: "walletsOf",
            args: [account.address],
          })),
        );
      } catch (err) {
        // Per factory: a retired one that no longer answers must not stop the
        // live one from being swept.
        stuck.push(`${name} @ ${factory}: could not list wallets (${err instanceof Error ? err.message : err})`);
      }
    }
    for (const wallet of wallets) {
      // Per WALLET, so one unsweepable wallet cannot strand the others. A wallet
      // whose ownership was transferred is listed here (walletsOf indexes the
      // CREATOR) but `withdraw` is onlyOwner, so a revert is reachable and must
      // not abort the loop or the deploy.
      try {
        const balance = await publicClient.readContract({
          address: BASE_SEPOLIA_ADDRESSES.realUsdc,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [wallet],
        });
        if (balance === 0n) continue;
        const args = [BASE_SEPOLIA_ADDRESSES.realUsdc, account.address, balance];
        // Simulate first, as every other chain write in this repo does.
        await publicClient.simulateContract({ address: wallet, abi: walletAbi, functionName: "withdraw", args, account });
        const client = createWalletClient({ chain: baseSepolia, account, transport: transport() });
        const hash = await client.writeContract({ address: wallet, abi: walletAbi, functionName: "withdraw", args });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
        if (receipt.status !== "success") throw new Error(`reverted in ${hash}`);
        recovered += balance;
        console.log(`   ${formatUnits(balance, 6)} USDC ${wallet} → ${account.address} (${name})`);
      } catch (err) {
        // A timeout is NOT proof the withdraw failed, so this says "unresolved"
        // rather than "failed" and never retries it here — a second withdraw for
        // the full balance reverts once the first mines.
        stuck.push(`${wallet} (${name}): ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  console.log(`   recovered ${formatUnits(recovered, 6)} USDC`);
  if (stuck.length > 0) {
    console.warn("!  these were NOT swept and may still hold funds:");
    for (const line of stuck) console.warn(`     ${line}`);
    console.warn("   Check them on Basescan before continuing; re-run with --skip-sweep to proceed.");
    die("aborting before the deploy so nothing is orphaned by accident.");
  }
}

// --------------------------------------------------------------- 2. broadcast

console.log("2. broadcasting DeployAll");
forge(["script", "script/DeployAll.s.sol", "--rpc-url", forgeRpc, "--broadcast"]);

// ------------------------------------------------------------------- 3. pin it

console.log("3. pinning addresses and the deploy block");
const runFile = resolve(contractsDir, "broadcast/DeployAll.s.sol/84532/run-latest.json");
if (!existsSync(runFile)) die(`no broadcast artifact at ${runFile}`);
const run = JSON.parse(readFileSync(runFile, "utf8"));

// This run, not a previous one. `run-latest.json` persists, so a broadcast that
// produced nothing would otherwise pin whatever was there before.
if (typeof run.timestamp === "number" && run.timestamp * 1000 < startedAt) {
  die("broadcast/run-latest.json predates this run — the deploy did not produce a new artifact.");
}
if (!Array.isArray(run.receipts) || run.receipts.length === 0) {
  die("broadcast artifact has no receipts — nothing was mined.");
}

// Matched by contract NAME rather than by position: the receipts array is
// ordered by nonce, and a future edit reordering the deploys would otherwise
// silently swap two addresses that both look valid.
const deployed = {};
run.transactions.forEach((tx, i) => {
  if (tx.transactionType !== "CREATE" || !tx.contractName) return;
  // A CREATE can mine AND revert, leaving a contractAddress that holds nothing.
  if (run.receipts[i]?.status !== "0x1") return;
  deployed[tx.contractName] = getAddress(tx.contractAddress);
});
const missing = ["GantryCore", "FixedRateSwap", "MockXSGD", "AgentPBMWalletFactory"].filter(
  (name) => !deployed[name],
);
if (missing.length > 0) die(`broadcast is missing a successful deploy for ${missing.join(", ")}`);

const blocks = run.receipts.map((r) => parseInt(r.blockNumber, 16)).filter(Number.isFinite);
if (blocks.length === 0) die("no receipt carried a block number — cannot derive a deploy floor.");
const deployBlock = Math.min(...blocks);

let source = readFileSync(addressesFile, "utf8");
/** Every substitution goes through this. `String.replace` on a pattern that does
 * not match returns the source UNCHANGED and silently — which for the deploy
 * block would ship new addresses with the old floor, and a wrong floor loses
 * logs without failing. */
const swap = (label, pattern, replacement) => {
  if (!pattern.test(source)) die(`could not find ${label} in addresses.ts — pin it by hand.`);
  source = source.replace(pattern, replacement);
};
for (const [key, name] of [
  ["gantryCore", "GantryCore"],
  ["fixedRateSwap", "FixedRateSwap"],
  ["mockXsgd", "MockXSGD"],
  ["agentPbmFactory", "AgentPBMWalletFactory"],
]) {
  // Checksummed, not forge's lowercase: the checksum lives in the capitalisation
  // and these four are printed on screens people read against Basescan.
  swap(key, new RegExp(`(${key}: ")0x[0-9a-fA-F]{40}(")`), `$1${deployed[name]}$2`);
}
swap("BASE_SEPOLIA_DEPLOY_BLOCK", /(export const BASE_SEPOLIA_DEPLOY_BLOCK = )[\d_]+n;/, `$1${deployBlock}n;`);
// The outgoing factory joins the recovery list, so the NEXT redeploy sweeps the
// wallets this one is retiring. Appended here rather than left to a human,
// because the failure is silent and permanent: funds in a wallet no factory
// lists are reachable only by someone who remembers the address.
const retiring = BASE_SEPOLIA_ADDRESSES.agentPbmFactory;
if (!BASE_SEPOLIA_RETIRED_FACTORIES.includes(retiring)) {
  swap(
    "BASE_SEPOLIA_RETIRED_FACTORIES",
    /(export const BASE_SEPOLIA_RETIRED_FACTORIES: readonly Address\[\] = \[\r?\n)/,
    `$1  "${retiring}", // retired ${new Date().toISOString().slice(0, 10)}\n`,
  );
}
writeFileSync(addressesFile, source);

// ------------------------------------------------------------- 4. local cache

// Done here rather than asked for, and it is the ONLY way to clear this host —
// there is no reset route and `demo:reset` deletes nothing. Two reasons it must
// happen: the cursor points into the old chain range, and wallets minted by the
// DEAD factory would keep answering the agent CLI's signer lookup, so
// `demo:reset` could arm one whose immutable CORE is the retired core.
const db = resolve(repoRoot, "packages/backend/gantry.db");
try {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(db + suffix)) rmSync(db + suffix);
  }
  console.log("4. dropped packages/backend/gantry.db (old cursor, old factory's wallets)");
} catch (err) {
  // A RUNNING backend holds this file open, and Windows refuses the unlink. That
  // is not a reason to fail a deploy that already succeeded — the contracts are
  // live and pinned, and this step is belt-and-braces: `agent_wallets` rows are
  // scoped to the factory that minted them, so the dead factory's are already
  // filtered out, and `demo:reset` floors the feed past everything the retired
  // core settled. Never let cleanup undo the report of what was deployed.
  // NOT harmless, and it must not be reported as such. `agent_wallets` rows are
  // factory-scoped so the dead factory's are filtered out — but `settlements`
  // has no core column and there is no reset route any more, so the retired
  // core's payments survive with no marker, render as current takings inside the
  // Overview window, and nothing can remove them but this file delete.
  console.warn(`!  could not delete ${db} (${err instanceof Error ? err.message : err}).`);
  console.warn("   The backend is running and holding it open. This is NOT harmless:");
  console.warn("   settlements from the RETIRED core survive with no marker, they will");
  console.warn("   render as current takings, and nothing else can remove them.");
  console.warn("   STOP the backend and delete gantry.db{,-wal,-shm} before rehearsing.");
  degraded = true;
}

// ----------------------------------------------------------------- 5. verify

if (!flag("--skip-verify")) {
  console.log("5. verifying on Basescan");
  // `verify-contract` per address, NOT `script --resume --verify`: resume wants an
  // unlocked wallet for transactions that are already mined, so it fails on a run
  // whose only remaining work is verification. Constructor args are re-encoded
  // from the addresses just deployed, which is also a cross-check that the
  // ordering in DeployAll matches what landed.
  const encode = (types, values) =>
    execFileSync("cast", ["abi-encode", `constructor(${types})`, ...values], {
      cwd: contractsDir,
      shell: true,
      encoding: "utf8",
    }).trim();
  const verify = (address, path, args) =>
    forge([
      "verify-contract",
      address,
      path,
      "--chain",
      "84532",
      ...(args ? ["--constructor-args", args] : []),
      "--watch",
    ]);
  try {
    verify(deployed.MockXSGD, "src/mocks/MockXSGD.sol:MockXSGD");
    verify(deployed.FixedRateSwap, "src/FixedRateSwap.sol:FixedRateSwap", encode("address", [deployed.MockXSGD]));
    verify(
      deployed.GantryCore,
      "src/GantryCore.sol:GantryCore",
      encode("address,address", [deployed.MockXSGD, deployer.address]),
    );
    verify(
      deployed.AgentPBMWalletFactory,
      "src/AgentPBMWalletFactory.sol:AgentPBMWalletFactory",
      encode("address", [deployed.GantryCore]),
    );
  } catch {
    // Deliberately not fatal, and deliberately AFTER the pin. Verification is the
    // flakiest step and the least coupled to correctness; a Basescan hiccup must
    // never cost the record of what was just deployed, which is unrecoverable.
    console.warn("!  verification failed. The contracts ARE deployed and pinned. Re-run:");
    console.warn("     cd packages/contracts && forge verify-contract <address> <path> --chain 84532 --watch");
  }
}

console.log("");
for (const [name, address] of Object.entries(deployed)) console.log(`${name.padEnd(22)} ${address}`);
console.log(`${"deploy block".padEnd(22)} ${deployBlock}`);
console.log("");
console.log("NEXT");
// No .env to repoint: addresses.ts was rewritten above, and it is the only
// thing anything reads. The scripts that took a core address in their env
// (SeedDemo, DeployPBM) were deleted on 11 Aug 2026.
console.log("  1. pnpm abis && pnpm lint && pnpm typecheck && pnpm test:contracts");
console.log("  2. restart the backend, then pnpm demo:reset (registers the demo shops)");
console.log("  3. update the address tables in CLAUDE.md, README.md and docs/submission/");
console.log("  4. commit and push — BOTH hosts inline these at build time, so Vercel and");
console.log("     Render each serve the dead core until they rebuild");

if (degraded) {
  console.log("");
  console.error("✗ DEPLOY SUCCEEDED, THIS HOST DID NOT. See the warning above and fix it before");
  console.error("  rehearsing — the addresses are pinned and correct, the local cache is not.");
  process.exit(1);
}
