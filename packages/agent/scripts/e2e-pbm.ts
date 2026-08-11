import { parseArgs } from "node:util";
import { env } from "../src/env";
import { checkPolicy, payMerchant } from "../src/pay-flow";

/**
 * Deterministic gantry-pbm acceptance harness — the agent's pay flow without
 * the LLM. Exit code asserts the outcome, so rehearsal scripts can gate on it:
 *
 *   pnpm --filter @gantry/agent e2e:pbm                       # S$4.50 team drinks must settle
 *   pnpm --filter @gantry/agent e2e:pbm -- --handle gadgethub-sg --sgd 4 --expect-denial
 *                                                             # must revert CategoryNotAllowed
 */
const { values } = parseArgs({
  // pnpm forwards the `--` separator literally — drop it or parseArgs demotes
  // every following option to a positional.
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    handle: { type: "string", default: "ah-hock-chicken-rice" },
    sgd: { type: "string", default: "4.50" },
    "expect-denial": { type: "boolean", default: false },
  },
});

const expectDenial = values["expect-denial"] as boolean;

const result = await payMerchant(values.handle as string, values.sgd as string);
console.log(JSON.stringify(result, null, 2));

/**
 * A denial has TWO halves and this harness used to assert only the first.
 *
 * The agent narrating `CategoryNotAllowed` proves the wallet refused. It proves
 * nothing about the record: the reason rides on the cancel transaction as an
 * `IntentDenied` event, which the indexer sweeps into the row the payer's
 * activity screen renders. Every part of that — the emit, the sweep, the decode,
 * the policy-name gate, the chain reads — could break and this script would still
 * print PASS, because the x402 response is computed before any of it happens.
 *
 * Polled rather than read once: the row appears when the WS watch delivers the
 * log (normally sub-second) or the 15s sweep does, whichever comes first.
 */
async function denialRecorded(wallet: string): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${env.gantryApi}/api/denials?wallet=${wallet}`);
      if (res.ok) {
        const body = (await res.json()) as { rows?: { errorName?: string }[] };
        if (body.rows?.some((row) => row.errorName === "CategoryNotAllowed")) return true;
      }
    } catch {
      // Transport blips are expected while the backend is mid-sweep; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

if (expectDenial) {
  if (result.success || result.errorReason !== "CategoryNotAllowed") {
    console.error(
      `FAIL: expected CategoryNotAllowed denial, got ${result.success ? "success" : result.errorReason}`,
    );
    process.exit(1);
  }
  console.log("PASS: on-chain CategoryNotAllowed denial surfaced as errorReason");

  const policy = await checkPolicy();
  if ("error" in policy) {
    console.error(`FAIL: could not resolve the agent's wallet to check the record (${policy.error})`);
    process.exit(1);
  }
  if (await denialRecorded(policy.wallet)) {
    console.log(`PASS: denial recorded and readable at /api/denials?wallet=${policy.wallet}`);
    process.exit(0);
  }
  console.error(
    `FAIL: the wallet refused, but no denial row appeared for ${policy.wallet} within 20s — ` +
      "the IntentDenied event, the sweep or the decode is broken",
  );
  process.exit(1);
}

if (result.success) {
  console.log(`PASS: settled ${result.explorerUrl}`);
  process.exit(0);
}
console.error(`FAIL: expected settlement, got ${result.errorReason}: ${result.errorMessage}`);
process.exit(1);
