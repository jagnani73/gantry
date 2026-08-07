import { parseArgs } from "node:util";
import { payMerchant } from "../src/pay-flow";

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

if (expectDenial) {
  if (!result.success && result.errorReason === "CategoryNotAllowed") {
    console.log("PASS: on-chain CategoryNotAllowed denial surfaced as errorReason");
    process.exit(0);
  }
  console.error(
    `FAIL: expected CategoryNotAllowed denial, got ${result.success ? "success" : result.errorReason}`,
  );
  process.exit(1);
}

if (result.success) {
  console.log(`PASS: settled ${result.explorerUrl}`);
  process.exit(0);
}
console.error(`FAIL: expected settlement, got ${result.errorReason}: ${result.errorMessage}`);
process.exit(1);
