import { formatUnits6, type PolicyResponse } from "@gantry/shared";
import * as narrator from "./narrator";
import { runCheckPolicy, runListMerchants, runPayMerchant } from "./tools";
import type { PayResult } from "./pay-flow";

/**
 * The scripted fallback: identical tool functions (real HTTP, real chain, real
 * money movement), pre-written narration streamed through the same typewriter.
 * Fires when the live model produces nothing within the timeout (hotspot flake,
 * missing key) — the demo's money path never depends on the LLM.
 */

const LUNCH = { handle: "ah-hock-chicken-rice", sgd: "19.50" };
const POWERBANK = { handle: "gadgethub-sg", sgd: "29" };

export function isDenialPrompt(prompt: string): boolean {
  return /powerbank|power bank|gadget|electronic/i.test(prompt);
}

function sgdFromPrompt(prompt: string, fallback: string): string {
  const match = /s?\$\s?(\d+(?:\.\d+)?)/i.exec(prompt);
  return match ? match[1]! : fallback;
}

function policySummary(policy: PolicyResponse & { dailyCapSgd?: string; spentTodaySgd?: string }): string {
  const rate = BigInt(policy.rate);
  const sgd = (units: string) => formatUnits6((BigInt(units) * rate) / 1_000_000n);
  return (
    `My policy allows S$${sgd(policy.dailyCap)} a day on ${policy.categories.join(", ")} — ` +
    `S$${sgd(policy.spentToday)} spent so far today, S$${sgd(policy.balance)} in the wallet.`
  );
}

async function narratePayment(result: PayResult, displayName: string): Promise<void> {
  if (result.success) {
    await narrator.type(
      `Done — I paid S$${result.sgd} to ${displayName}. My policy wallet settled it on-chain ` +
        `(the wallet is the payer, my key only authorized).\n\nTransaction: ${result.explorerUrl}\n`,
    );
    return;
  }
  if (result.errorReason === "CategoryNotAllowed") {
    await narrator.type(
      `The chain refused it: ${result.errorReason} — my wallet is purpose-bound money and only ` +
        `spends at food & beverage merchants; ${displayName} is electronics. The contract rejected ` +
        `the settlement itself, so no funds moved.\n`,
    );
    return;
  }
  await narrator.type(
    `The payment did not go through: ${result.errorReason ?? "unknown"} — ` +
      `${result.errorMessage ?? "no further detail"}. No funds moved.\n`,
  );
}

export async function runScripted(prompt: string): Promise<void> {
  if (isDenialPrompt(prompt)) {
    const sgd = sgdFromPrompt(prompt, POWERBANK.sgd);
    await narrator.type(`A S$${sgd} powerbank from GadgetHub SG — let me check my spend policy first.\n`);
    const policy = JSON.parse(await runCheckPolicy()) as PolicyResponse;
    await narrator.type(
      `${policySummary(policy)} A powerbank is electronics, but the wallet enforces policy ` +
        `on-chain — I'll submit the payment and let the contract decide.\n`,
    );
    const result = JSON.parse(await runPayMerchant({ handle: POWERBANK.handle, sgd })) as PayResult;
    await narratePayment(result, "GadgetHub SG");
    return;
  }

  const sgd = sgdFromPrompt(prompt, LUNCH.sgd);
  await narrator.type("I'll get the team lunch sorted. Checking the merchants first.\n");
  const merchants = JSON.parse(await runListMerchants()) as { handle: string; displayName?: string }[];
  const ahHock = merchants.find((m) => m.handle === LUNCH.handle);
  await narrator.type(
    `${ahHock?.displayName ?? "Ah Hock Chicken Rice"} is live at Maxwell Food Centre. ` +
      `Now checking what my policy allows.\n`,
  );
  const policy = JSON.parse(await runCheckPolicy()) as PolicyResponse;
  await narrator.type(`${policySummary(policy)} S$${sgd} for lunch fits — paying now.\n`);
  const result = JSON.parse(await runPayMerchant({ handle: LUNCH.handle, sgd })) as PayResult;
  await narratePayment(result, ahHock?.displayName ?? "Ah Hock Chicken Rice");
}
