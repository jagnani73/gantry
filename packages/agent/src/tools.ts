import { tool } from "ai";
import { z } from "zod";
import { formatUnits6 } from "@gantry/shared";
import { checkPolicy, listMerchants, payMerchant } from "./pay-flow";
import * as narrator from "./narrator";

/**
 * Tool layer: deterministic HTTP + signing INSIDE the run functions — the LLM
 * only sees JSON results and narrates them. The exported run* functions are
 * shared with the scripted fallback so both modes print identical tool-status
 * lines and execute identical wire traffic.
 *
 * Fallback safety, two mechanisms:
 * - `toolCallsStarted` increments BEFORE each effectful call (an attempted
 *   counter, not a completed one — a payMerchant whose settlement lands while
 *   the response is lost must still count). The fallback may only engage
 *   while it is 0.
 * - `lockLiveTools()` freezes the LIVE runner's tools once the fallback
 *   engages, so an abandoned-but-still-draining runner can never start a new
 *   tool. The scripted engine calls the raw run* functions and is unaffected.
 */
export let toolCallsStarted = 0;

let liveToolsLocked = false;
export function lockLiveTools(): void {
  liveToolsLocked = true;
}

function guardLive<Input>(fn: (input: Input) => Promise<string>): (input: Input) => Promise<string> {
  return async (input: Input) => {
    if (liveToolsLocked) {
      return JSON.stringify({ error: "live run abandoned — tool locked; no action was taken" });
    }
    return fn(input);
  };
}

export async function runListMerchants(): Promise<string> {
  toolCallsStarted++;
  narrator.toolStatus("list_merchants");
  const merchants = await listMerchants();
  return JSON.stringify(merchants);
}

export async function runCheckPolicy(): Promise<string> {
  toolCallsStarted++;
  narrator.toolStatus("check_my_policy");
  const policy = await checkPolicy();
  if ("error" in policy) return JSON.stringify(policy);
  // Pre-digest the S$ conversions so the model narrates consistent numbers.
  const rate = BigInt(policy.rate);
  const toSgd = (units: string) => formatUnits6((BigInt(units) * rate) / 1_000_000n);
  return JSON.stringify({
    ...policy,
    dailyCapSgd: toSgd(policy.dailyCap),
    spentTodaySgd: toSgd(policy.spentToday),
    balanceSgd: toSgd(policy.balance),
  });
}

export async function runPayMerchant(input: { handle: string; sgd: string }): Promise<string> {
  toolCallsStarted++;
  narrator.toolStatus(`pay_merchant ${input.handle} S$${input.sgd}`);
  const result = await payMerchant(input.handle, input.sgd);
  return JSON.stringify(result);
}

export const agentTools = {
  list_merchants: tool({
    description:
      "List the merchants that accept Gantry payments, with display name, location and category. Entries carrying an `error` field failed to load — say so instead of assuming the merchant does not exist.",
    inputSchema: z.object({}),
    execute: guardLive(runListMerchants),
  }),
  check_my_policy: tool({
    description:
      "Read the agent's on-chain PBM spend policy: daily cap, spent so far today, allowed categories, expiry, wallet balance (raw 6dp token units plus pre-converted S$ fields). A result carrying an `error` field means the policy could not be read — say so instead of assuming any particular policy.",
    inputSchema: z.object({}),
    execute: guardLive(runCheckPolicy),
  }),
  pay_merchant: tool({
    description:
      "Pay a merchant in SGD through the Gantry x402 gantry-pbm rail (the on-chain policy wallet pays; you only authorize). Returns the settlement result. The on-chain policy may REJECT the payment — if so, report the errorReason name verbatim (e.g. CategoryNotAllowed) and explain it plainly. NEVER call this tool a second time for the same purchase, whatever the first result said — transport errors and unknown outcomes included; report them and stop. Never invent transaction hashes.",
    inputSchema: z.object({
      handle: z.string().describe('Merchant handle, e.g. "ah-hock-chicken-rice"'),
      sgd: z.string().describe('SGD amount as a decimal string, e.g. "4.50"'),
    }),
    execute: guardLive(runPayMerchant),
  }),
};
