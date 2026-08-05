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
relayer  ${BASE_SEPOLIA_RELAYER}  (${relayerEth} ETH)

contracts (Base Sepolia)
  GantryCore     ${BASE_SEPOLIA_ADDRESSES.gantryCore}
  FixedRateSwap  ${BASE_SEPOLIA_ADDRESSES.fixedRateSwap}
  MockUSDC       ${BASE_SEPOLIA_ADDRESSES.mockUsdc}
  MockXSGD       ${BASE_SEPOLIA_ADDRESSES.mockXsgd}
  Circle USDC    ${BASE_SEPOLIA_ADDRESSES.realUsdc}

demo urls
  payer      ${app}/pay/ah-hock-chicken-rice?burner=1
  dashboard  ${app}/dashboard
  print QR   ${app}/qr/ah-hock-chicken-rice

done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
