import { assertUnixSeconds } from "./time";

/**
 * One reading of "is this agent allowed to spend right now", because the naive
 * one is wrong.
 *
 * `revoked` is DERIVED — it is always `expiry === 0` — so a badge rendered from
 * it alone calls a policy Active right up until the payment reverts. A policy
 * that simply ran out (`0 < expiry < now`) denies every spend with the same
 * `PolicyExpired` a revoked one does, while `revoked` stays false. On stage
 * that is the worst possible failure: the console says the agent is armed and
 * the agent says it is not.
 *
 * The comparison is pinned to AgentPBMWallet.authorizeSpend, which reverts when
 * `block.timestamp > expiry` — so `expiry` is the last second at which spends
 * are allowed, and `now === expiry` is still active.
 */
export type AgentStatus =
  /** The wallet will accept a spend, policy-wise (caps and balance are separate
   * questions). */
  | "active"
  /** Armed once, ran out. Denies with PolicyExpired; re-arming is a setPolicy,
   * not an un-revoke. */
  | "lapsed"
  /** Never armed, or explicitly revoked — both are expiry 0. */
  | "revoked";

/**
 * Pass CHAIN time when you have it. A wall clock is fine for a badge, but the
 * chain is what decides, and a laptop minutes ahead of it would show "lapsed"
 * for a policy that still works.
 */
export function agentStatus(
  policy: { expiry: number; revoked?: boolean },
  nowUnixSeconds: number,
): AgentStatus {
  assertUnixSeconds(nowUnixSeconds, "clock");
  // Anything that is not a positive real expiry is treated as revoked rather
  // than trusted: a NaN from a failed read compares false against everything,
  // and the failure it would otherwise produce is "Active" forever.
  if (!Number.isFinite(policy.expiry) || policy.expiry <= 0) return "revoked";
  if (policy.revoked === true) return "revoked";
  return nowUnixSeconds > policy.expiry ? "lapsed" : "active";
}
