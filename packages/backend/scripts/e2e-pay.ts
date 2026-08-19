/**
 * CLI payer harness: quote → create → sign EIP-3009 → settle.
 * The pre-web verification path for the Human door (the agent tooling lives
 * in packages/agent, built on its own pay-flow client).
 *
 * Usage: pnpm --filter @gantry/backend e2e:pay [-- --sgd 1.50 --handle ah-hock-chicken-rice]
 * Env: E2E_PAYER_KEY (optional; fresh random key when unset),
 *      GANTRY_API (default http://localhost:4000)
 * The funder top-up always runs (per-address 60s cooldown applies).
 */
import { parseArgs } from "node:util";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  BASESCAN_BASE_URL,
  parseSgd,
  reviveTypedData,
  formatUnits6,
  type TokenId,
  type ApiErrorBody,
  type IntentResponse,
  type SettleResponse,
} from "@gantry/shared";

const { values: args } = parseArgs({
  // pnpm forwards the `--` separator literally — drop it or parseArgs demotes
  // every following option to a positional.
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    sgd: { type: "string", default: "1.50" },
    handle: { type: "string", default: "ah-hock-chicken-rice" },
    /** Which of Circle real tokens the payer signs against. The whole point of
     * the flag is that NOTHING else in this script changes: same faucet, same
     * intent call, same EIP-3009 signature, same settle — only the asset. If
     * paying in euros needed a second code path it would not be the same door. */
    token: { type: "string", default: "USDC" },
  },
});

const api = process.env.GANTRY_API ?? "http://localhost:4000";
const token = args.token as TokenId;
const payerKey = (process.env.E2E_PAYER_KEY as `0x${string}` | undefined) ?? generatePrivateKey();
const payer = privateKeyToAccount(payerKey);

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${api}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = (await res.json()) as T | ApiErrorBody;
  if (!res.ok) {
    const err = body as ApiErrorBody;
    throw new Error(`${path} → ${res.status} ${err.error?.name}: ${err.error?.message}`);
  }
  return body as T;
}

async function main() {
  console.log(`payer: ${payer.address}${process.env.E2E_PAYER_KEY ? "" : " (fresh burner)"}`);

  const faucet = await call<{ txHash: string; funded: string }>("/api/faucet", {
    method: "POST",
    body: JSON.stringify({ address: payer.address, token }),
  });
  console.log(`funder: sent ${formatUnits6(BigInt(faucet.funded))} ${token} (${faucet.txHash})`);

  const xsgdAmount = parseSgd(args.sgd!).toString();
  const intent = await call<IntentResponse>("/api/intents", {
    method: "POST",
    body: JSON.stringify({ handle: args.handle, xsgdAmount, token }),
  });
  console.log(
    `intent ${intent.intentId}\n  S$${formatUnits6(BigInt(intent.xsgdAmount))} → ${formatUnits6(BigInt(intent.amountIn), 6)} ${intent.tokenSymbol} @ ${formatUnits6(BigInt(intent.rate), 4)}`,
  );

  const signature = await payer.signTypedData(reviveTypedData(intent.typedData, payer.address));
  console.log(`signed EIP-3009 authorization (nonce = intentId)`);

  const settled = await call<SettleResponse>(`/api/intents/${intent.intentId}/settle`, {
    method: "POST",
    body: JSON.stringify({
      payer: payer.address,
      signature,
      validBefore: intent.validBefore,
    }),
  });
  console.log(
    `settled in block ${settled.blockNumber}: xsgdOut ${formatUnits6(BigInt(settled.xsgdOut), 6)} (fee ${formatUnits6(BigInt(settled.feeXsgd), 6)})`,
  );
  console.log(`  ${BASESCAN_BASE_URL}/tx/${settled.txHash}`);

  // Replay the same signature — must surface a decoded conflict, not a 500.
  const replay = await fetch(`${api}/api/intents/${intent.intentId}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payer: payer.address, signature, validBefore: intent.validBefore }),
  });
  const replayBody = (await replay.json()) as ApiErrorBody;
  console.log(
    `replay check: ${replay.status} ${replayBody.error?.name ?? "?"} (${replayBody.error?.message ?? ""})`,
  );
  if (replay.ok || !replayBody.error?.name) {
    throw new Error("replay should have failed with a decoded error");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
