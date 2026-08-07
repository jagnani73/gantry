// One-command demo reset: clears the backend cache (SQLite + SSE `reset`
// broadcast, cursor jumped to head), re-arms the agent policy, and prints the
// demo cheat-sheet. Chain state (merchant, pool, contracts) is reused —
// Sepolia redeploys are not needed per rehearsal. (Local-Anvil redeploy
// orchestration is deferred, not planned — see CLAUDE.md, Chain/infra.)
//
// Usage: pnpm demo:reset
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const envFile of [
  resolve(repoRoot, "packages/backend/.env"),
  resolve(repoRoot, "packages/web/.env.local"),
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
  console.error("ADMIN_TOKEN not found (expected in packages/backend/.env)");
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
let policyLine;
const arm = await fetch(`${backend}/api/admin/policy/arm`, {
  method: "POST",
  headers: { "x-admin-token": adminToken },
});
if (arm.ok) {
  const policyRes = await fetch(`${backend}/api/policy`).catch(() => null);
  if (policyRes?.ok) {
    const p = await policyRes.json();
    const sgd = (units) => (Number(BigInt(units) * BigInt(p.rate)) / 1e12).toFixed(2);
    policyLine =
      `policy re-armed: S$${sgd(p.dailyCap)}/day · ${p.categories.join(", ")} · ` +
      `spent S$${sgd(p.spentToday)} · wallet S$${sgd(p.balance)} ${p.token}`;
    if (BigInt(p.balance) < BigInt(p.dailyCap)) {
      if (p.token === "MUSDC") {
        // Only MockUSDC has an open mint — the faucet cannot serve real USDC.
        const faucet = await fetch(`${backend}/api/faucet`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address: p.wallet }),
        }).catch(() => null);
        policyLine += faucet?.ok
          ? " (low — faucet top-up sent)"
          : ` ⚠ LOW and faucet top-up failed (${faucet ? `status ${faucet.status}: ${await faucet.text()}` : "network error"})`;
      } else {
        policyLine += ` ⚠ LOW on ${p.token} and the faucet cannot mint it — fund the wallet manually or set ORDER_TOKEN=MUSDC`;
      }
    }
  } else {
    // The arm LANDED — do not claim the wallet is missing; the readback flaked.
    policyLine = `⚠ policy re-armed but readback failed (${policyRes ? `status ${policyRes.status}` : "network error"}) — verify GET /api/policy manually`;
  }
} else if (arm.status === 404) {
  // Distinguish "no wallet configured" from "stale backend without the route".
  const body = await arm.json().catch(() => null);
  policyLine =
    body?.error?.name === "PolicyWalletUnconfigured"
      ? "⚠ PBM wallet not deployed yet — agent beats unavailable"
      : "⚠ /api/admin/policy/arm missing (stale backend build?) — re-arm did NOT run; spentToday accumulates";
} else {
  policyLine = `⚠ policy re-arm failed: ${arm.status} ${await arm.text()}`;
}

// The rejection beat needs gadgethub-sg registered on-chain.
const gadget = await fetch(`${backend}/api/merchants/gadgethub-sg`);
const gadgetLine = gadget.ok
  ? "gadgethub-sg registered (category electronics — the rejection beat)"
  : "⚠ gadgethub-sg NOT registered on-chain — the rejection beat will fail";

// Best-effort probe: a flaky RPC must not crash the script AFTER a successful
// reset (the cheat sheet below is the whole point of running it).
let relayerEth = "?";
// BASE_SEPOLIA_RPC_URL is a comma-separated fallback list; probe the primary.
const probeRpc = (process.env.BASE_SEPOLIA_RPC_URL ?? "")
  .split(",")
  .map((u) => u.trim())
  .find((u) => u.length > 0);
if (probeRpc) {
  try {
    const res = await fetch(probeRpc, {
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
  } catch {
    relayerEth = "? (balance probe failed)";
  }
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
  payer      ${app}/pay/ah-hock-chicken-rice
  dashboard  ${app}/dashboard
  print QR   ${app}/qr/ah-hock-chicken-rice

agent beats
  lunch      pnpm --filter @gantry/agent start "buy the team lunch (S\\$19.50) from Ah Hock"
  rejection  pnpm --filter @gantry/agent start "buy a S\\$29 powerbank at GadgetHub"
  e2e        pnpm --filter @gantry/agent e2e:pbm [-- --handle gadgethub-sg --sgd 29 --expect-denial]

done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
