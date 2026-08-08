import {
  CATEGORY_LABELS,
  categoryName,
  formatUnits6,
  parseSgd,
  quoteAmountIn,
  type AgentSummary,
  type DenialEvent,
} from "@gantry/shared";

/**
 * The policy layer of the agents screen: what the owner types, what the contract
 * stores, and what a refusal means in English.
 */

/**
 * Category ids → the wallet's `categoryBitmap`. Bit N is category N, which is
 * why ids are constrained to < 256 on-chain: the whole registry fits in one
 * word. `CATEGORIES` starts at 1, so bit 0 is never set.
 */
export function categoryBitmapOf(ids: readonly number[]): bigint {
  return ids.reduce((bitmap, id) => bitmap | (1n << BigInt(id)), 0n);
}

/** The inverse, for pre-filling the edit form from what is on-chain. Bounded at
 * 256 because that is the contract's own ceiling on a category id. */
export function categoryIdsOf(bitmap: bigint): number[] {
  const ids: number[] = [];
  for (let id = 0; id < 256; id++) {
    if ((bitmap >> BigInt(id)) & 1n) ids.push(id);
  }
  return ids;
}

/**
 * A cap the owner typed in S$ → the token units the CONTRACT stores.
 *
 * Ceiling, via the same helper that quotes a payment: a cap floored below the
 * amount it is meant to allow would refuse the very payment the owner set it
 * for. The S$ figure is therefore a display convention on both ends — the
 * contract only ever knew about USDC — and every screen showing it back must
 * say the rate is owner-set.
 */
export function capUnitsFromSgd(sgd: string, rate: bigint): bigint {
  return quoteAmountIn(parseSgd(sgd), rate);
}

/** Token units → the S$ string to prefill an input with. Two places, because
 * that is what the input accepts back. */
export function sgdFromCapUnits(units: string | bigint, rate: bigint): string {
  const value = typeof units === "bigint" ? units : BigInt(units);
  return formatUnits6((value * rate) / 1_000_000n, 2);
}

/** "Food & Beverage · Retail" — the human reading of a bitmap's decoded names. */
export function categoryLabels(names: readonly string[]): string {
  if (names.length === 0) return "None";
  const byName = new Map(
    Object.entries(CATEGORY_LABELS).map(([id, label]) => [categoryName(Number(id)), label]),
  );
  return names.map((name) => byName.get(name) ?? name).join(" · ");
}

export interface DenialReading {
  /** The on-chain rule that fired, named the way the contract names it. */
  rule: string;
  /** Plain English NEXT TO the verbatim error name, never instead of it. */
  explanation: string;
}

function argOf(denial: DenialEvent, key: string): string | undefined {
  const args = denial.errorArgs;
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return value === undefined || value === null ? undefined : String(value);
}

/**
 * Why the wallet said no.
 *
 * `errorName` travels verbatim from the revert and is rendered as-is; this only
 * supplies the sentence beside it. The rule string names the policy field the
 * contract checked, because "your agent is not allowed to shop here" is not
 * actionable and "categoryBitmap · Food & Beverage only" is — it tells the owner
 * exactly which knob to turn.
 *
 * `agent` may be absent: the denial is stored with the wallet address only, and
 * a wallet the payer no longer owns (or has not finished loading) still has to
 * render a receipt. Everything the agent would have supplied degrades to the
 * revert's own arguments.
 */
export function readDenial(
  denial: DenialEvent,
  agent: AgentSummary | undefined,
  merchantCategory: string | undefined,
): DenialReading {
  const allowed = agent ? categoryLabels(agent.categories) : undefined;
  const rate = agent ? BigInt(agent.rate) : null;
  const sgd = (units: string | undefined): string | undefined =>
    units === undefined || rate === null ? undefined : `S$${sgdFromCapUnits(units, rate)}`;

  switch (denial.errorName) {
    case "CategoryNotAllowed":
      return {
        rule: allowed ? `categoryBitmap · ${allowed} only` : "categoryBitmap",
        explanation: merchantCategory
          ? `${merchantCategory} is not in this agent's allowed categories.`
          : "This shop's category is not in this agent's allowed categories.",
      };
    case "DailyCapExceeded":
      return {
        rule: `dailyCap · ${sgd(argOf(denial, "cap")) ?? "the daily allowance"} a day`,
        explanation: "This payment would have pushed the agent past its daily allowance.",
      };
    case "PerTxCapExceeded":
      return {
        rule: `perTxCap · ${sgd(argOf(denial, "cap")) ?? "the per-payment limit"} a payment`,
        explanation: "This payment is larger than the agent's per-payment limit.",
      };
    case "PolicyExpired":
      return {
        rule: "expiry · policy no longer live",
        explanation: "This agent's policy has expired or been revoked, so every spend reverts.",
      };
    case "InsufficientWalletBalance":
      return {
        rule: "balance",
        explanation: "The agent's wallet did not hold enough USDC to cover the payment.",
      };
    case "InvalidAgentSignature":
      return {
        rule: "agentSigner",
        explanation: "The authorization was not signed by this wallet's registered agent signer.",
      };
    default:
      return {
        rule: denial.errorName,
        explanation: "The wallet's on-chain policy refused this payment.",
      };
  }
}
