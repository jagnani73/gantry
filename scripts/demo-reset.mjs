// One-command demo reset. In order, it:
//   1. clears the backend cache (SQLite + SSE `reset`, cursor jumped to head)
//   2. tops the FUNDER up — this can execute a real three-transaction Uniswap v3
//      ETH→USDC swap, so this script spends real balances, not just state
//   3. tops the demo PBM wallet up (a real USDC transfer)
//   4. re-arms the agent policy on-chain (setPolicy, resets spentToday)
//   5. checks gadgethub-sg, then prints the cheat sheet
// Chain state (merchant, contracts, listed swap rate) is reused — Sepolia
// redeploys are not needed per rehearsal. Exits non-zero if any step degraded.
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

const started = Date.now();

// Guarded like every other call below: an unreachable backend should say so in
// one line, not dump an undici stack trace as the first thing an operator sees.
const reset = await fetch(`${backend}/api/admin/reset`, {
  method: "POST",
  headers: { "x-admin-token": adminToken },
}).catch((err) => {
  console.error(`cannot reach the backend at ${backend} (${err instanceof Error ? err.message : err}) — is \`pnpm dev\` running?`);
  process.exit(1);
});
if (!reset.ok) {
  console.error(`reset failed: ${reset.status} ${await reset.text()}`);
  process.exit(1);
}
const healthRes = await fetch(`${backend}/health`).catch(() => null);
if (!healthRes?.ok) {
  console.error(`health check failed after reset: ${healthRes ? healthRes.status : "network error"}`);
  process.exit(1);
}
const health = await healthRes.json();

// Order matters below, and it is the reverse of what reads naturally.
//
//   funder top-up  →  wallet top-up  →  policy arm  →  readback
//
// The funder is the SUPPLY and the PBM wallet is a CONSUMER of it: topUpPbmWallet
// throws FunderExhausted when the funder cannot cover the send, so refilling the
// funder afterwards "fixes" it one step too late and the wallet stays empty for
// that rehearsal. And the wallet top-up is deliberately NOT nested under a
// successful policy arm — they touch different resources, and a wallet left
// underfunded makes the S$4 GadgetHub beat die as insufficient_funds instead of
// CategoryNotAllowed, which is the wrong story entirely.
let degraded = false;

/** Every network call here is best-effort: a flake must not crash the script
 * after the cache was cleared and money moved, because the cheat sheet below is
 * the whole point of running it. */
async function post(path) {
  try {
    const res = await fetch(`${backend}${path}`, { method: "POST", headers: { "x-admin-token": adminToken } });
    return { res, body: res.ok ? await res.json().catch(() => null) : await res.text().catch(() => "") };
  } catch (err) {
    return { res: null, body: err instanceof Error ? err.message : String(err) };
  }
}

// 1. Funder: reports ETH/USDC/WETH and swaps ETH for USDC when USDC runs low.
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
    funderLine = `⚠ funder  ${BASE_SEPOLIA_RELAYER}  top-up failed (${res ? `${res.status}: ${body}` : body}) — every door spends this key`;
  }
}

// 2. PBM wallet: needs enough for the drinks order AND the rejection attempt,
//    whose facilitator balance pre-check runs before the on-chain policy check.
let walletUsdc = null;
let walletLine;
{
  const { res, body } = await post("/api/admin/wallet/topup");
  if (res?.ok && body) {
    const usdc = Number(body.usdc);
    walletUsdc = Number.isFinite(usdc) ? usdc : null;
    walletLine =
      `agent wallet ${walletUsdc === null ? "balance unreadable" : `${walletUsdc.toFixed(2)} USDC`}` +
      (body.sent !== "0" ? ` (topped up +${Number(body.sent).toFixed(2)})` : "");
  } else {
    degraded = true;
    walletLine =
      `⚠ agent wallet top-up FAILED (${res ? `${res.status}: ${body}` : body}) — ` +
      `the rejection beat will die as insufficient_funds, not CategoryNotAllowed`;
  }
}

// 3. Policy: setPolicy resets the wallet's spentToday counter, so ten S$4.50
//    rehearsals never pile into the S$50/day cap.
let policyLine;
{
  const { res, body } = await post("/api/admin/policy/arm");
  if (res?.ok) {
    const policyRes = await fetch(`${backend}/api/policy`).catch(() => null);
    if (policyRes?.ok) {
      const p = await policyRes.json();
      const sgd = (units) => (Number(BigInt(units) * BigInt(p.rate)) / 1e12).toFixed(2);
      policyLine =
        `policy re-armed: S$${sgd(p.dailyCap)}/day · ${p.categories.join(", ")} · ` +
        `spent S$${sgd(p.spentToday)} · ${walletLine}`;
    } else {
      degraded = true;
      // The arm LANDED — do not claim the wallet is missing; the readback flaked.
      policyLine = `⚠ policy re-armed but readback failed (${policyRes ? `status ${policyRes.status}` : "network error"}) — verify GET /api/policy manually · ${walletLine}`;
    }
  } else {
    degraded = true;
    policyLine =
      (res?.status === 404
        ? // The wallet address is a committed constant, so the route cannot 404 for a
          // missing wallet — a 404 means the running backend predates the route.
          "⚠ /api/admin/policy/arm missing (stale backend build?) — re-arm did NOT run; spentToday accumulates"
        : `⚠ policy re-arm failed: ${res ? `${res.status} ${body}` : body}`) + ` · ${walletLine}`;
  }
}

// 4. The rejection beat needs gadgethub-sg registered on-chain. A non-404 is NOT
//    evidence of absence — an RPC failure surfaces as a 500 here, and reporting
//    that as "not registered" sends the operator to re-register a live merchant.
let gadgetLine;
{
  const gadget = await fetch(`${backend}/api/merchants/gadgethub-sg`).catch(() => null);
  if (gadget?.ok) {
    gadgetLine = "gadgethub-sg registered (category electronics — the rejection beat)";
  } else if (gadget?.status === 404) {
    degraded = true;
    gadgetLine = "⚠ gadgethub-sg NOT registered on-chain — the rejection beat will fail";
  } else {
    degraded = true;
    gadgetLine = `⚠ could not verify gadgethub-sg (${gadget ? `status ${gadget.status}` : "network error"}) — registration state UNKNOWN`;
  }
}

/** A warning must never wear a checkmark. The old template hardcoded `✓ ${line}`
 * and rendered "✓ ⚠ policy re-arm failed" on the one screen an operator scans
 * before going on stage. */
const mark = (line) => (line.startsWith("⚠") ? line : `✓ ${line}`);

console.log(`${mark(`dashboard cleared, indexer cursor → block ${health.indexerCursor} (chain ${health.chainId})`)}
${mark(policyLine)}
${mark(gadgetLine)}
${mark(funderLine)}

contracts (Base Sepolia)
  GantryCore     ${BASE_SEPOLIA_ADDRESSES.gantryCore}
  FixedRateSwap  ${BASE_SEPOLIA_ADDRESSES.fixedRateSwap}
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
  rejection  pnpm --filter @gantry/agent start "buy a S\\$4 phone cable at GadgetHub"
  e2e        pnpm --filter @gantry/agent e2e:pbm [-- --handle gadgethub-sg --sgd 4 --expect-denial]

done in ${((Date.now() - started) / 1000).toFixed(1)}s`);

// Exit code asserts the outcome, matching the convention e2e-pbm.ts documents —
// the pre-rehearsal script was the one thing that could not be gated on. The
// cheat sheet prints first: it is why the script exists, and a degraded run still
// needs it.
if (degraded) {
  console.error("\n⚠ demo-reset finished DEGRADED — fix the warnings above before rehearsing.");
  process.exit(1);
}
