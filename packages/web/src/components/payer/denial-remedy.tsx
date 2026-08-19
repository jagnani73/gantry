"use client";

import {
  BASE_SEPOLIA_ADDRESSES,
  CATEGORY_LABELS,
  DIMENSION_ERROR,
  checkSpend,
  formatUnits6,
  tokenAddress,
  type AgentSummary,
  type DenialEvent,
  type MerchantResponse,
  type PolicyVerdict,
} from "@gantry/shared";
import { Card } from "@/components/primitives";
import { usePayer } from "./payer-context";

/**
 * The way out of a refusal.
 *
 * A denial used to be a dead end: the receipt named the rule that stopped the
 * payment and left the payer there. But the rule is theirs — the wallet is
 * payer-owned and only its owner can change it — so the one thing this screen
 * was missing is the thing only its reader can do.
 *
 * It re-checks the SAME payment against the policy as it stands NOW, which is a
 * different question from what the receipt records. The recorded reason is
 * history and never changes; this says whether the agent is still refused
 * today, and if the payer has since widened the rules it says that instead. So
 * the loop closes visibly rather than requiring them to work it out.
 *
 * Nothing here writes. It opens the policy editor with the refused category
 * already ticked, and every guard on that form — the fresh on-chain read, the
 * preserved expiry, the confirm — still applies.
 *
 * Renders NOTHING when the wallet is not one of the payer's own: a stranger's
 * agent cannot be retuned by them, and offering it would be a button that can
 * only fail.
 */
export function DenialRemedy({
  denial,
  agent,
  record,
}: {
  denial: DenialEvent;
  agent: AgentSummary | undefined;
  record: MerchantResponse | null | undefined;
}) {
  const { chainNow, pushOverlay } = usePayer();

  // Both are required, and neither is guaranteed: the agents list is enumerated
  // from factory logs and the merchant may still be loading. Silence beats a
  // half-answer about someone's spending rules.
  if (!agent || !record) return null;

  // The caps and the amount must be denominated in the SAME token or the
  // comparison below is arithmetic across two currencies.
  //
  // `denial.amountIn` is historical and in `denial.tokenIn`; every field of the
  // policy is current and in whatever token the wallet holds NOW, which is
  // derived rather than fixed. A wallet refunded or refunded-into a different
  // currency since the refusal would have euros checked against dollar caps —
  // ~13% at the demo rates, enough to flip the verdict either way — and the
  // output is not a number but a sentence: "nothing in this agent's current
  // rules would stop this payment", over a payment that would still revert.
  // No answer is the honest one; the receipt above still states what happened.
  if (tokenAddress(BASE_SEPOLIA_ADDRESSES, agent.token).toLowerCase() !== denial.tokenIn.toLowerCase()) {
    return null;
  }

  const verdict: PolicyVerdict = checkSpend(
    {
      expiry: agent.expiry,
      categoryBitmap: BigInt(agent.categoryBitmap),
      perTxCap: BigInt(agent.perTxCap),
      dailyCap: BigInt(agent.dailyCap),
      spentToday: BigInt(agent.spentToday),
      balance: BigInt(agent.balance),
    },
    {
      categoryId: record.categoryId,
      amount: BigInt(denial.amountIn),
      // Chain time, never the device clock — a laptop minutes fast would call a
      // live policy lapsed and offer to fix something that is not broken.
      atUnixSeconds: chainNow(),
    },
  );

  if (verdict.allowed) return <NowAllowed />;

  const category = verdict.refusedBy === "category" ? record.categoryId : null;
  return (
    <Card radius="card-m" pad="none" className="px-5.5 py-5">
      <p className="text-card-title-xs">Still refused today</p>
      <p className="mt-2 text-body-sm text-quiet">
        {describe(verdict, denial, record)} These are your agent&apos;s rules, and you are the
        only address that can change them.
      </p>
      <button
        type="button"
        onClick={() =>
          pushOverlay({
            kind: "agentForm",
            wallet: agent.wallet,
            ...(category === null ? {} : { addCategory: category }),
          })
        }
        className="focus-ring mt-4 h-12 w-full rounded-control-m bg-ink text-btn-sm text-paper transition-colors hover:bg-ink-hover"
      >
        {/* The display label, not the on-chain slug: this is a button someone
            reads, and `electronics` is the wire name. An id the registry does
            not know still renders as itself rather than vanishing. */}
        {category === null
          ? "Change this agent's rules"
          : `Allow ${CATEGORY_LABELS[category] ?? `category ${category}`}`}
      </button>
    </Card>
  );
}

function NowAllowed() {
  return (
    <Card radius="card-m" pad="none" className="px-5.5 py-5">
      <p className="text-card-title-xs">Your rules have changed since</p>
      {/* Deliberately not "it would succeed": the on-chain check tests the
          agent's signature before any of this, and a policy that admits a
          payment is not a promise that one will be made. */}
      <p className="mt-2 text-body-sm text-quiet">
        Nothing in this agent&apos;s current rules would stop this payment. The refusal above is
        what happened at the time, and stays on record.
      </p>
    </Card>
  );
}

/** Why it is still refused, in the payer's units rather than the contract's. */
function describe(verdict: PolicyVerdict, denial: DenialEvent, record: MerchantResponse): string {
  const sgd = `S$${formatUnits6(BigInt(denial.xsgdAmount))}`;
  switch (verdict.refusedBy) {
    case "category":
      return `Your agent still cannot buy from ${(CATEGORY_LABELS[record.categoryId] ?? record.categoryName).toLowerCase()} shops.`;
    case "perTx":
      return `${sgd} is still more than this agent may spend in one payment.`;
    case "daily":
      return `${sgd} would still put this agent past what it may spend in a day.`;
    case "expiry":
      return "This agent's policy is not live, so every payment reverts.";
    case "balance":
      return "The agent's wallet still does not hold enough to cover it.";
    default:
      // Unreachable while refusedBy is non-null, but a silent empty string here
      // would leave a card with a heading and no reason.
      return `This payment is still refused (${verdict.errorName ?? DIMENSION_ERROR.category}).`;
  }
}
