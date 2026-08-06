// One-command demo reset: clears the backend cache (SQLite + SSE `reset`
// broadcast, cursor jumped to head) and prints the demo cheat-sheet.
// Chain state (merchant, pool, contracts) is reused — Sepolia redeploys are
// not needed per rehearsal. Full local-Anvil redeploy orchestration is M4.
//
// Usage: pnpm demo:reset
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const envFile of [
  resolve(repoRoot, "apps/backend/.env"),
  resolve(repoRoot, "apps/web/.env.local"),
]) {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

// Node ≥22.18 (or ≥23.6) strips TS types natively, so the shared source imports directly.
const { BASE_SEPOLIA_ADDRESSES, BASE_SEPOLIA_RELAYER } = await import(
  "../packages/shared/src/addresses.ts"
);

const backend = process.env.NEXT_PUBLIC_BACKEND_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const app = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) {
  console.error("ADMIN_TOKEN not found (expected in apps/backend/.env)");
  process.exit(1);
}

const started = Date.now();

const reset = await fetch(`${backend}/api/admin/reset`, {
  method: "POST",
  headers: { "x-admin-token": adminToken },
});
if (!reset.ok) {
  console.error(`reset failed: ${reset.status} ${await reset.text()}`);
  process.exit(1);
}
const healthRes = await fetch(`${backend}/health`);
if (!healthRes.ok) {
  console.error(`health check failed after reset: ${healthRes.status}`);
  process.exit(1);
}
const health = await healthRes.json();

// Re-arm the agent policy: setPolicy resets the wallet's spentToday counter,
// so ten S$19.50 rehearsals never pile into the S$50/day cap.
let policyLine = "⚠ PBM wallet not deployed yet — agent beats unavailable";
const arm = await fetch(`${backend}/api/admin/policy/arm`, {
  method: "POST",
  headers: { "x-admin-token": adminToken },
});
if (arm.ok) {
  const policyRes = await fetch(`${backend}/api/policy`);
  if (policyRes.ok) {
    const p = await policyRes.json();
    const sgd = (units) => (Number(BigInt(units) * BigInt(p.rate)) / 1e12).toFixed(2);
    policyLine =
      `policy re-armed: S$${sgd(p.dailyCap)}/day · ${p.categories.join(", ")} · ` +
      `spent S$${sgd(p.spentToday)} · wallet S$${sgd(p.balance)}`;
    // Top up the wallet through the open-mint faucet when it runs low.
    if (BigInt(p.balance) < BigInt(p.dailyCap)) {
      const faucet = await fetch(`${backend}/api/faucet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: p.wallet }),
      });
      policyLine += faucet.ok
        ? " (low — faucet top-up sent)"
        : " ⚠ low balance and faucet top-up failed";
    }
  }
} else if (arm.status !== 404) {
  policyLine = `⚠ policy re-arm failed: ${arm.status} ${await arm.text()}`;
}

// The rejection beat needs gadgethub-sg registered on-chain.
const gadget = await fetch(`${backend}/api/merchants/gadgethub-sg`);
const gadgetLine = gadget.ok
  ? "gadgethub-sg registered (category electronics — the rejection beat)"
  : "⚠ gadgethub-sg NOT registered on-chain — the rejection beat will fail";

let relayerEth = "?";
if (process.env.BASE_SEPOLIA_RPC_URL) {
  const res = await fetch(process.env.BASE_SEPOLIA_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [BASE_SEPOLIA_RELAYER, "latest"],
    }),
  }).then((r) => r.json());
  if (res.result) relayerEth = (Number(BigInt(res.result)) / 1e18).toFixed(4);
}

console.log(`✓ dashboard cleared, indexer cursor → block ${health.indexerCursor} (chain ${health.chainId})
✓ ${policyLine}
✓ ${gadgetLine}
relayer  ${BASE_SEPOLIA_RELAYER}  (${relayerEth} ETH)

contracts (Base Sepolia)
  GantryCore     ${BASE_SEPOLIA_ADDRESSES.gantryCore}
  FixedRateSwap  ${BASE_SEPOLIA_ADDRESSES.fixedRateSwap}
  MockUSDC       ${BASE_SEPOLIA_ADDRESSES.mockUsdc}
  MockXSGD       ${BASE_SEPOLIA_ADDRESSES.mockXsgd}
  Circle USDC    ${BASE_SEPOLIA_ADDRESSES.realUsdc}
  PBM factory    ${BASE_SEPOLIA_ADDRESSES.agentPbmFactory}
  PBM wallet     ${BASE_SEPOLIA_ADDRESSES.demoAgentPbmWallet}

demo urls
  payer      ${app}/pay/ah-hock-chicken-rice?burner=1
  dashboard  ${app}/dashboard
  print QR   ${app}/qr/ah-hock-chicken-rice

agent beats
  lunch      pnpm --filter @gantry/agent start "buy the team lunch from Ah Hock"
  rejection  pnpm --filter @gantry/agent start "buy a S\\$29 powerbank at GadgetHub"
  e2e        pnpm --filter @gantry/agent e2e:pbm [-- --handle gadgethub-sg --sgd 29 --expect-denial]

done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
