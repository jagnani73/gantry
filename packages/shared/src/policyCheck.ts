import { agentStatus } from "./agentStatus";
import { assertUnixSeconds } from "./time";

/**
 * What the wallet would do, computed from public state.
 *
 * `AgentPBMWallet.authorizeSpend` refuses for one of six reasons, and five of
 * them are decidable by anyone: the policy struct, `spentToday()`, the token
 * balance and the merchant's `categoryId` are all public getters. Only the
 * signature check is not, because the signature is never stored or emitted.
 *
 * That gap is the whole reason this module exists. A denial we record is
 * relayer-ATTESTED — `IntentDenied` carries bytes we supply — and re-simulating
 * `authorizeSpend` without the agent's signature returns `InvalidAgentSignature`
 * whatever the real reason was, so a third party could never reproduce our
 * claim. Recomputing the policy from public state at the denial's block is the
 * half of that which needs no trust at all: it cannot prove the agent asked, but
 * it proves the wallet would have refused, and names the same dimension.
 *
 * Used in both directions. Forwards it answers "would this be refused?" before
 * anyone signs; backwards it answers "was that refusal correct?" against a
 * denial already on chain. One implementation, so the prediction and the audit
 * can never disagree.
 *
 * IT DELIBERATELY DOES NOT CHECK A SIGNATURE, and callers must not imply that it
 * did. See `SIGNATURE_IS_NOT_CHECKED`.
 */

/** The dimensions `authorizeSpend` tests, in the order it tests them. The order
 * is the contract's and is pinned by test: the FIRST failure is the one that
 * reverts, so a checker that evaluates them in another order can name a
 * different reason than the chain did for the same inputs. */
export const POLICY_DIMENSIONS = ["expiry", "category", "perTx", "daily", "balance"] as const;

export type PolicyDimension = (typeof POLICY_DIMENSIONS)[number];

/** The contract's error name for each dimension — the vocabulary a receipt, the
 * facilitator and the indexer already speak. Verbatim, because a contract's own
 * error name is the fact and a friendlier gloss may sit beside it, never instead
 * of it. */
export const DIMENSION_ERROR: Record<PolicyDimension, string> = {
  expiry: "PolicyExpired",
  category: "CategoryNotAllowed",
  perTx: "PerTxCapExceeded",
  daily: "DailyCapExceeded",
  balance: "InsufficientWalletBalance",
};

/**
 * The one thing this module cannot answer, stated so a caller has to acknowledge
 * it rather than forget it.
 *
 * `authorizeSpend` checks the agent's EIP-712 signature FIRST. A spend this
 * module calls allowed is a spend the wallet allows *given a valid signature* —
 * and a real refusal may have been `InvalidAgentSignature` while every policy
 * dimension here reads fine.
 */
export const SIGNATURE_IS_NOT_CHECKED =
  "the agent's signature is checked first on-chain and is not public, so this recomputes the policy only";

export interface PolicyState {
  /** Last second at which spends are allowed. 0 = revoked or never armed. */
  expiry: number;
  /** Bit n set = merchant categoryId n allowed. */
  categoryBitmap: bigint;
  perTxCap: bigint;
  dailyCap: bigint;
  /** `spentToday()` — already day-bucketed by the contract, so it is 0 on a new
   * UTC day without the caller doing arithmetic. */
  spentToday: bigint;
  /** The wallet's balance of the spend token. */
  balance: bigint;
}

export interface SpendRequest {
  categoryId: number;
  amount: bigint;
  /** Chain time, not a wall clock: expiry is decided by `block.timestamp`. */
  atUnixSeconds: number;
}

export interface DimensionResult {
  dimension: PolicyDimension;
  /** Did this specific check pass? */
  ok: boolean;
  /** The contract error this dimension reverts with, when it fails. */
  errorName: string;
  /** What the chain says, and what the spend needed — both sides, so a reader
   * can redo the comparison rather than trust the verdict. */
  actual: string;
  required: string;
}

export interface PolicyVerdict {
  /** True only if every dimension passed. Still assumes a valid signature. */
  allowed: boolean;
  /** The dimension that reverts — the FIRST failure, which is the only one the
   * chain reports. Null when allowed. */
  refusedBy: PolicyDimension | null;
  /** The contract error name for `refusedBy`. Null when allowed. */
  errorName: string | null;
  /** Every dimension, in contract order, whether or not it decided the outcome.
   * A refusal is more legible beside the checks that passed. */
  checks: DimensionResult[];
}

/**
 * Recompute the wallet's decision.
 *
 * Evaluates every dimension so a caller can show the whole picture, but reports
 * `refusedBy` as the first failure in the contract's order — which is what
 * actually reverts, and therefore the only reason the chain ever names.
 */
export function checkSpend(policy: PolicyState, request: SpendRequest): PolicyVerdict {
  assertUnixSeconds(request.atUnixSeconds, "spend time");

  const expired = agentStatus({ expiry: policy.expiry }, request.atUnixSeconds) !== "active";
  // Shifts of 256+ are 0 in Solidity, and `1n << 300n` is enormous in JS — so an
  // out-of-range categoryId must be treated as "no bit", matching the contract's
  // comment, rather than producing a bitmask nothing can satisfy.
  const bit =
    request.categoryId >= 0 && request.categoryId < 256 ? 1n << BigInt(request.categoryId) : 0n;
  const attempted = policy.spentToday + request.amount;

  const checks: DimensionResult[] = [
    {
      dimension: "expiry",
      ok: !expired,
      errorName: DIMENSION_ERROR.expiry,
      actual: policy.expiry === 0 ? "revoked (expiry 0)" : `expiry ${policy.expiry}`,
      required: `at or after ${request.atUnixSeconds}`,
    },
    {
      dimension: "category",
      ok: bit !== 0n && (policy.categoryBitmap & bit) !== 0n,
      errorName: DIMENSION_ERROR.category,
      actual: `bitmap ${policy.categoryBitmap}`,
      required: `bit ${request.categoryId} set (${bit})`,
    },
    {
      dimension: "perTx",
      ok: request.amount <= policy.perTxCap,
      errorName: DIMENSION_ERROR.perTx,
      actual: `amount ${request.amount}`,
      required: `at most perTxCap ${policy.perTxCap}`,
    },
    {
      dimension: "daily",
      ok: attempted <= policy.dailyCap,
      errorName: DIMENSION_ERROR.daily,
      actual: `spentToday ${policy.spentToday} + ${request.amount} = ${attempted}`,
      required: `at most dailyCap ${policy.dailyCap}`,
    },
    {
      dimension: "balance",
      ok: policy.balance >= request.amount,
      errorName: DIMENSION_ERROR.balance,
      actual: `balance ${policy.balance}`,
      required: `at least ${request.amount}`,
    },
  ];

  const first = checks.find((check) => !check.ok) ?? null;
  return {
    allowed: first === null,
    refusedBy: first?.dimension ?? null,
    errorName: first?.errorName ?? null,
    checks,
  };
}

/**
 * Does a denial we published agree with public state?
 *
 * The audit direction. `claimed` is the error name our `IntentDenied` carried;
 * the verdict is recomputed independently. Three outcomes, and the third is the
 * one that makes this worth shipping:
 *
 * - `consistent` — the chain would have refused, for the reason we said.
 * - `contradicted` — the chain says otherwise. Either the record is wrong or it
 *   was computed against different state; either way, do not trust the record.
 * - `unprovable` — the claim is real but not decidable from public state now
 *   (an `InvalidAgentSignature`, or a dimension whose inputs have since moved).
 *
 * A checker that can only ever agree proves nothing, which is why
 * `contradicted` exists and is tested against a fabricated claim.
 */
export type DenialAudit = "consistent" | "contradicted" | "unprovable";

export function auditDenial(claimed: string, verdict: PolicyVerdict): DenialAudit {
  if (!POLICY_DIMENSIONS.some((d) => DIMENSION_ERROR[d] === claimed)) return "unprovable";
  if (verdict.errorName === claimed) return "consistent";
  return "contradicted";
}
