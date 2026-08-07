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
// so ten S$4.50 rehearsals never pile into the S$50/day cap.
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
    // Enough for one agent purchase (S$4.50 ~ 3.35 USDC) plus margin. NOT the
    // daily cap: that is 37 USDC of real money sitting idle in a demo wallet.
    const WALLET_FLOOR = 4_000_000n;
    if (BigInt(p.balance) < WALLET_FLOOR) {
      const funder = await fetch(`${backend}/api/faucet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: p.wallet }),
      }).catch(() => null);
      if (funder?.ok) {
        const { funded } = await funder.json();
        const after = BigInt(p.balance) + BigInt(funded);
        policyLine +=
          after < WALLET_FLOOR
            ? ` ⚠ topped up but STILL LOW (${(Number(after) / 1e6).toFixed(2)} USDC) — run demo:reset again or fund the wallet directly`
            : ` (low — funder sent ${(Number(BigInt(funded)) / 1e6).toFixed(2)} USDC)`;
      } else {
        policyLine += ` ⚠ LOW and the funder failed (${funder ? `status ${funder.status}: ${await funder.text()}` : "network error"})`;
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

// Funder: reports ETH + USDC and swaps ETH for USDC when it runs low. Best
// effort — a flaky RPC must not crash the script AFTER a successful reset (the
// cheat sheet below is the whole point of running it).
let funderLine = `relayer  ${BASE_SEPOLIA_RELAYER}  (balance probe skipped)`;
try {
  const res = await fetch(`${backend}/api/admin/funder/topup`, {
    method: "POST",
    headers: { "x-admin-token": adminToken },
  });
  if (res.ok) {
    const f = await res.json();
    funderLine =
      `funder   ${f.funder}  ${Number(f.eth).toFixed(4)} ETH · ${Number(f.usdc).toFixed(2)} USDC` +
      (f.swapped ? `
         ↳ ${f.detail}` : "");
  } else {
    const body = await res.text();
    funderLine = `⚠ funder  ${BASE_SEPOLIA_RELAYER}  top-up failed (${res.status}): ${body}`;
  }
} catch (err) {
  funderLine = `⚠ funder  ${BASE_SEPOLIA_RELAYER}  unreachable (${err instanceof Error ? err.message : err})`;
}

console.log(`✓ dashboard cleared, indexer cursor → block ${health.indexerCursor} (chain ${health.chainId})
✓ ${policyLine}
✓ ${gadgetLine}
${funderLine}

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
  drinks     pnpm --filter @gantry/agent start "buy 3 iced teas for the team (S\\$4.50) from Ah Hock"
  rejection  pnpm --filter @gantry/agent start "buy a S\\$29 powerbank at GadgetHub"
  e2e        pnpm --filter @gantry/agent e2e:pbm [-- --handle gadgethub-sg --sgd 29 --expect-denial]

done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
