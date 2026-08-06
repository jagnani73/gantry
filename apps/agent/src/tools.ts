import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
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
 * The fallback-safety counter: the scripted engine may only take over while
 * NO tool has completed (a payment must never run twice).
 */
export let completedToolCalls = 0;

export async function runListMerchants(): Promise<string> {
  narrator.toolStatus("list_merchants");
  const merchants = await listMerchants();
  completedToolCalls++;
  return JSON.stringify(merchants);
}

export async function runCheckPolicy(): Promise<string> {
  narrator.toolStatus("check_my_policy");
  const policy = await checkPolicy();
  completedToolCalls++;
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
  narrator.toolStatus(`pay_merchant ${input.handle} S$${input.sgd}`);
  const result = await payMerchant(input.handle, input.sgd);
  completedToolCalls++;
  return JSON.stringify(result);
}

export const agentTools = [
  betaZodTool({
    name: "list_merchants",
    description: "List the merchants that accept Gantry payments, with display name, location and category.",
    inputSchema: z.object({}),
    run: runListMerchants,
  }),
  betaZodTool({
    name: "check_my_policy",
    description:
      "Read the agent's on-chain PBM spend policy: daily cap, spent so far today, allowed categories, expiry, wallet balance (raw 6dp token units plus pre-converted S$ fields).",
    inputSchema: z.object({}),
    run: runCheckPolicy,
  }),
  betaZodTool({
    name: "pay_merchant",
    description:
      "Pay a merchant in SGD over the Gantry x402 gantry-pbm rail (the on-chain policy wallet pays; you only authorize). Returns the settlement result. The on-chain policy may REJECT the payment — if so, report the errorReason name verbatim (e.g. CategoryNotAllowed) and explain it plainly. Never invent transaction hashes.",
    inputSchema: z.object({
      handle: z.string().describe('Merchant handle, e.g. "ah-hock-chicken-rice"'),
      sgd: z.string().describe('SGD amount as a decimal string, e.g. "19.50"'),
    }),
    run: runPayMerchant,
  }),
];
