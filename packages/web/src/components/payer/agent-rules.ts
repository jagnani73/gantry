import type { Address } from "viem";
import {
  BASE_SEPOLIA_ADDRESSES,
  CATEGORY_LABELS,
  CATEGORY_OPTIONS,
  categoryName,
  formatUnits6,
  parseSgd,
  quoteAmountIn,
  tokenAddress,
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

/**
 * Everything an owner write can change, as one comparable string.
 *
 * It exists to answer one question after a write: has the read caught up? The
 * browser holds a MINED receipt for what it sent, so any read returning
 * something else is behind — the backend's RPC provider is not the one the
 * browser confirmed against, and a read issued a moment after the block is
 * routinely served by a replica that has not seen it. Comparing fingerprints is
 * how the screen tells "still catching up" from "this is what the chain holds",
 * which are otherwise the same stale numbers.
 *
 * The label is in it because renaming is its own transaction now: a save that
 * changes ONLY the name would otherwise match the fingerprint immediately and
 * paint the old name as though it were current.
 *
 * **The agent signer is in it for the same reason and a sharper one.** Rotating
 * the session key is its own transaction too, so a signer-only save would match
 * instantly — and the field it leaves stale is the one a payer rotating a leaked
 * key is on that screen specifically to check. A Signer row still showing the
 * key you just replaced is the worst single line this screen can render.
 *
 * Compared LOWERCASE as defence, not because the two sides are known to differ:
 * both are EIP-55 today (the write side checksums through `getAddress`, and
 * `AgentSummary.agentSigner` comes off a live `agentSigner()` multicall, which
 * viem returns checksummed — it is NOT read from the lowercased swept table).
 * An earlier version of this note claimed the swept table was the source and
 * that a literal compare would never match; both halves were false. What the
 * normalisation genuinely buys is that a fingerprint cannot start disagreeing
 * with itself if either side's casing ever changes, which is cheap insurance on
 * a comparison whose failure is invisible.
 *
 * `spentToday` and the balance are deliberately out: they move on their own, so
 * folding them in would make the expectation unsatisfiable. `withdraw` therefore
 * records no expectation at all rather than a satisfiable-but-meaningless one.
 */
/**
 * Everything an owner write can change about a wallet.
 *
 * The exact set `policyFingerprint` hashes, and therefore the exact set the
 * freshness gate can wait on. `spentToday`, the balance and the rate are
 * deliberately absent: they move without anyone signing anything, so a gate
 * including them would never settle, and a row overlaid with them would state
 * figures no receipt proves.
 */
export interface ExpectedAgentState {
  dailyCap: bigint | string;
  perTxCap: bigint | string;
  expiry: number;
  categoryBitmap: bigint | string;
  label: string;
  /** `Address`, not `string`: the form holds the signer as raw input state, and
   * the difference between the correct `getAddress(signer.trim())` and the raw
   * field was invisible to the compiler. Passing the raw one would produce a
   * fingerprint that can NEVER match, whose symptom is not an error but the
   * detail screen waiting out all six polls and then blaming the RPC. */
  agentSigner: Address;
}

export function policyFingerprint(state: ExpectedAgentState): string {
  return [state.dailyCap, state.perTxCap, state.expiry, state.categoryBitmap]
    .map(String)
    .concat(state.label, state.agentSigner.toLowerCase())
    .join("|");
}

/** What `revoke()` leaves behind: the policy zeroed, expiry included. The label
 * and the signer both survive a revoke untouched, so the caller supplies the
 * ones already on-chain rather than assuming the wallet lost them too. */
export function revokedState(label: string, agentSigner: Address): ExpectedAgentState {
  return { dailyCap: 0n, perTxCap: 0n, expiry: 0, categoryBitmap: 0n, label, agentSigner };
}

/**
 * The `AgentSummary` fields a mined receipt PROVES, projected from what was
 * written.
 *
 * A mined receipt outranks a lagging read — the rule the merchant payout
 * rotation already follows — so a row known to be behind renders THESE rather
 * than a spinner or the values they replaced. The browser watched the block; it
 * does not need a replica's permission to say what is in it.
 *
 * `categories` and `revoked` are derived here rather than carried, because both
 * are functions of what was signed and reading them back is exactly the thing
 * being worked around. `revoked` is derived the same way the backend derives it
 * (`expiry === 0`, per `AgentSummary`), so an overlaid row and a read one can
 * never disagree about the chip above them.
 */
export function provenAgentFields(
  state: ExpectedAgentState,
  /**
   * Did a `setPolicy` or `revoke` land in this save?
   *
   * It changes what the receipt proves, and leaving it out was a bug. Both calls
   * go through `AgentPBMWallet._setPolicy`, which writes `_spentToday = 0` and
   * stamps `policyUpdatedAt` — so a mined policy receipt proves the day's spend
   * is ZERO, and the earlier blanket "those move on their own" was true of the
   * balance and the rate and false of `spentToday` for exactly the two writes
   * that record an expectation. Overlaying new caps onto a stale spend rendered
   * "S$30.00 of S$20.00 today", a state no block has ever held, and fed the same
   * mixture to `checkSpend` on the denial-remedy card.
   *
   * `setLabel` and `setAgentSigner` deliberately do NOT reset the counter (the
   * contract says so), so a name- or signer-only save must leave both alone.
   */
  policyWritten: boolean,
): Pick<
  AgentSummary,
  | "dailyCap"
  | "perTxCap"
  | "expiry"
  | "categoryBitmap"
  | "categories"
  | "label"
  | "agentSigner"
  | "revoked"
> &
  Partial<Pick<AgentSummary, "spentToday" | "policyUpdatedAt">> {
  return {
    ...(policyWritten
      ? {
          spentToday: "0",
          // We know it was re-stamped and we do NOT know to what — the block
          // timestamp is not threaded back here. `0` is the wallet's own "never
          // armed" value, which every render site already treats as "show
          // nothing". Absent beats wrong, and the stale date is wrong: it is the
          // one line on the screen whose whole job is to date the rules.
          policyUpdatedAt: 0,
        }
      : {}),
    dailyCap: String(state.dailyCap),
    perTxCap: String(state.perTxCap),
    expiry: state.expiry,
    // Stringified from the same value the fingerprint hashes, so the two
    // readings of one bitmap cannot drift.
    categoryBitmap: String(state.categoryBitmap),
    categories: categoryIdsOf(BigInt(state.categoryBitmap)).map(categoryName),
    label: state.label,
    agentSigner: state.agentSigner,
    revoked: state.expiry === 0,
  };
}

/** Bytes, not characters — `AgentPBMWallet._setLabel` counts `bytes(label).length`,
 * so eight 4-byte emoji are already over a limit that fits 31 ASCII characters.
 * A counter that measured codepoints (as the merchant profile limits deliberately
 * do) would offer a label the contract refuses. */
export const LABEL_MAX_BYTES = 31;

export function labelByteLength(label: string): number {
  return new TextEncoder().encode(label).length;
}

/** "Food & Beverage · Retail" — the human reading of a bitmap's decoded names. */
export function categoryLabels(names: readonly string[]): string {
  if (names.length === 0) return "None";
  const byName = new Map(
    Object.entries(CATEGORY_LABELS).map(([id, label]) => [categoryName(Number(id)), label]),
  );
  return names.map((name) => byName.get(name) ?? name).join(" · ");
}

/**
 * What this policy admits, and what it turns away.
 *
 * Listing only the allowed set makes a refusal something the owner discovers
 * when their agent is already at the till. The bitmap has always known the
 * answer in advance, so the screen can say it in advance.
 *
 * The two sides are NOT symmetric, and the asymmetry is the honest part:
 *
 * - `allowed` is whatever the bitmap decoded to, including a name this build
 *   has no label for. An owner can set any bit under 256 and the contract will
 *   honour it, so dropping an unrecognised name would hide a real permission
 *   behind a UI that only knows four.
 * - `denied` can only ever cover the categories Gantry KNOWS. There are 256
 *   possible bits and no way to enumerate the rest meaningfully, so this is a
 *   statement about the four kinds of shop that exist here — which is what the
 *   caller has to say out loud rather than implying a complete list.
 */
export function categorySplit(names: readonly string[]): {
  allowed: string[];
  denied: string[];
} {
  const byName = new Map(
    Object.entries(CATEGORY_LABELS).map(([id, label]) => [categoryName(Number(id)), label]),
  );
  const allowedNames = new Set(names);
  return {
    allowed: names.map((name) => byName.get(name) ?? name),
    denied: CATEGORY_OPTIONS.filter((option) => !allowedNames.has(option.name)).map(
      (option) => option.label,
    ),
  };
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
  // The agent is consulted ONLY for its rate, which is a display conversion.
  // Nothing describing what happened may be read off it: this is a historical
  // record and the agent is current state, and the two diverge the moment the
  // owner uses the remedy loop on the very receipt they are reading.
  //
  // And only when it is a rate for the RIGHT currency. `agent.rate` became
  // per-wallet when a wallet's currency started being derived from what it
  // holds, so a wallet funded in a different token since this refusal reports a
  // rate that never applied to it — converting a cap denominated in one
  // currency at another's rate, ~13% adrift at the demo rates, printed as a
  // definite figure like "dailyCap · S$50.00 a day". The cap's own units are
  // the denial's `tokenIn`; with no matching rate the figure is omitted, which
  // the callers below already handle.
  const sameCurrency =
    agent !== undefined && tokenAddress(BASE_SEPOLIA_ADDRESSES, agent.token).toLowerCase() === denial.tokenIn.toLowerCase();
  const rate = sameCurrency ? BigInt(agent.rate) : null;
  const sgd = (units: string | undefined): string | undefined =>
    units === undefined || rate === null ? undefined : `S$${sgdFromCapUnits(units, rate)}`;

  switch (denial.errorName) {
    case "CategoryNotAllowed": {
      // From the REVERT's own argument, never from the agent's current
      // categories. Its siblings below already work this way — DailyCapExceeded
      // names the cap the contract actually compared against — and this case
      // reaching for live state was a bug the remedy loop makes reachable BY
      // DESIGN: the moment a payer widens the policy, every past refusal began
      // claiming the rule that stopped it was a list that now contains the very
      // category it refused. It only ever looked right because nobody had
      // changed the list yet.
      const refused = argOf(denial, "categoryId");
      const refusedLabel =
        refused === undefined
          ? undefined
          : (CATEGORY_LABELS[Number(refused)] ?? categoryName(Number(refused)));
      return {
        rule: refusedLabel ? `categoryBitmap · ${refusedLabel} not allowed` : "categoryBitmap",
        explanation: merchantCategory
          ? `${merchantCategory} was not in this agent's allowed categories at the time.`
          : "This shop's category was not in this agent's allowed categories at the time.",
      };
    }
    case "DailyCapExceeded":
      return {
        rule: `dailyCap · ${sgd(argOf(denial, "cap")) ?? "the daily allowance"} a day`,
        explanation: "This payment would have pushed the agent past its daily allowance.",
      };
    case "PerTxCapExceeded":
      return {
        rule: `perTxCap · ${sgd(argOf(denial, "cap")) ?? "the per-payment limit"} a payment`,
        explanation: "This payment was larger than the agent's per-payment limit at the time.",
      };
    case "PolicyExpired":
      return {
        rule: "expiry · policy no longer live",
        explanation:
          "This agent's policy had expired or been revoked when this was attempted, so every spend reverted.",
      };
    case "InsufficientWalletBalance":
      return {
        rule: "balance",
        // No token named: a euro agent's wallet holds EURC, and the amount is
        // already on the row above in its own currency.
        explanation: "The agent's wallet did not hold enough to cover the payment.",
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
