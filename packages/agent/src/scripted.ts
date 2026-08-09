import { formatUnits6, type AgentSummary } from "@gantry/shared";
import * as narrator from "./narrator";
import { runCheckPolicy, runListMerchants, runPayMerchant } from "./tools";
import type { MerchantListEntry, PayResult } from "./pay-flow";

/**
 * The scripted fallback: identical tool functions (real HTTP, real chain, real
 * money movement), pre-written narration streamed through the same typewriter.
 * Fires when the live model produces nothing within the timeout (hotspot flake,
 * missing key) — the demo's money path never depends on the LLM.
 */

const DRINKS = { handle: "ah-hock-chicken-rice", sgd: "4.50" };
const CABLE = { handle: "gadgethub-sg", sgd: "4" };

/** Reasons that PROVE nothing moved. Anything else (outcome_unknown,
 * unexpected_status, unresolved settle outcomes) must not be narrated as
 * "no funds moved" — the settle may have mined after a receipt timeout. */
const DEFINITE_NO_FUNDS = new Set([
  "CategoryNotAllowed",
  "PerTxCapExceeded",
  "DailyCapExceeded",
  "PolicyExpired",
  "InvalidAgentSignature",
  "InsufficientWalletBalance",
  "insufficient_funds",
  "invalid_request",
  "quote_changed",
  "intent_creation_failed",
  "transport_error",
  "no_pbm_offer",
  "missing_header",
  "malformed_header",
]);

/** checkPolicy reports failures in-band for the live model's benefit; the
 * scripted path has no model to narrate them, so surface it as a throw the
 * runScripted catch already handles. */
function requirePolicy(json: string): AgentSummary {
  const parsed = JSON.parse(json) as AgentSummary | { error: string };
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

export function isDenialPrompt(prompt: string): boolean {
  return /cable|charger|powerbank|power bank|gadget|electronic/i.test(prompt);
}

function sgdFromPrompt(prompt: string, fallback: string): string {
  const match = /s?\$\s?(\d+(?:\.\d+)?)/i.exec(prompt);
  return match ? match[1]! : fallback;
}

function policySummary(policy: AgentSummary): string {
  const rate = BigInt(policy.rate);
  const sgd = (units: string) => formatUnits6((BigInt(units) * rate) / 1_000_000n);
  return (
    `My policy allows S$${sgd(policy.dailyCap)} a day on ${policy.categories.join(", ")}. ` +
    `S$${sgd(policy.spentToday)} spent so far today, S$${sgd(policy.balance)} in the wallet.`
  );
}

async function narratePayment(result: PayResult, displayName: string): Promise<void> {
  if (result.success) {
    const receiptLine = result.txHash
      ? `\n\nTransaction: ${result.explorerUrl}\n`
      : `\n\n${result.note ?? "Settled. See the dashboard row for the receipt."}\n`;
    await narrator.type(
      `Done. I paid S$${result.sgd} to ${displayName}. My policy wallet settled it on-chain ` +
        `(the wallet is the payer, my key only authorized).${receiptLine}`,
    );
    return;
  }
  if (result.errorReason === "CategoryNotAllowed") {
    await narrator.type(
      `The chain refused it: ${result.errorReason}. My wallet is purpose-bound money and only ` +
        `spends at food & beverage merchants; ${displayName} is electronics. The contract rejected ` +
        `the settlement itself, so no funds moved.\n`,
    );
    return;
  }
  if (DEFINITE_NO_FUNDS.has(result.errorReason)) {
    await narrator.type(
      `The payment did not go through. ${result.errorReason}: ` +
        `${result.errorMessage}. No funds moved.\n`,
    );
    return;
  }
  await narrator.type(
    `The payment attempt ended without a confirmed result (${result.errorReason}: ` +
      `${result.errorMessage}). The outcome is unconfirmed: check the dashboard before retrying.\n`,
  );
}

export async function runScripted(prompt: string): Promise<void> {
  try {
    if (isDenialPrompt(prompt)) {
      const sgd = sgdFromPrompt(prompt, CABLE.sgd);
      await narrator.type(`A S$${sgd} phone cable from GadgetHub SG. Let me check my spend policy first.\n`);
      const policy = requirePolicy(await runCheckPolicy());
      await narrator.type(
        `${policySummary(policy)} A cable is electronics, but the wallet enforces policy ` +
          `on-chain, so I'll submit the payment and let the contract decide.\n`,
      );
      const result = JSON.parse(await runPayMerchant({ handle: CABLE.handle, sgd })) as PayResult;
      await narratePayment(result, "GadgetHub SG");
      return;
    }

    const sgd = sgdFromPrompt(prompt, DRINKS.sgd);
    await narrator.type("I'll get the team their drinks. Checking the merchants first.\n");
    const merchants = JSON.parse(await runListMerchants()) as MerchantListEntry[];
    const ahHock = merchants.find(
      (m): m is Extract<MerchantListEntry, { displayName?: string }> =>
        m.handle === DRINKS.handle && !("error" in m),
    );
    await narrator.type(
      `${ahHock?.displayName ?? "Ah Hock Chicken Rice"} is live at Maxwell Food Centre. ` +
        `Now checking what my policy allows.\n`,
    );
    const policy = JSON.parse(await runCheckPolicy()) as AgentSummary;
    await narrator.type(`${policySummary(policy)} S$${sgd} for three iced teas fits. Paying now.\n`);
    const result = JSON.parse(await runPayMerchant({ handle: DRINKS.handle, sgd })) as PayResult;
    await narratePayment(result, ahHock?.displayName ?? "Ah Hock Chicken Rice");
  } catch (err) {
    // Only the read tools (checkPolicy) throw; payMerchant returns structured
    // results — so reaching here means nothing was paid in THIS step.
    await narrator.type(
      `I hit a problem talking to the Gantry backend (${err instanceof Error ? err.message : String(err)}). ` +
        `Check that the backend is running, then try again.\n`,
    );
    process.exitCode = 1;
  }
}
