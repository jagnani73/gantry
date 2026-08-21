import { emptyBudget, msUntilReset, release, reserve, type BudgetState } from "./faucet-budget";

/**
 * A rolling ceiling PER KEY, on top of the shared one.
 *
 * `faucet-budget` bounds a total; this bounds any single target's share of it,
 * and profile editing needs both. The per-IP cooldown paces a defacement loop
 * without bounding its total, and a shared ceiling is spent wherever the
 * attacker points it — so sixty edits at one a minute was one hour to consume a
 * whole deployment's 24-hour allowance on a single shop, after which every
 * merchant including the real owner was refused for the remaining 23. A control
 * that turns a defacement into a rail-wide outage is worse than what it bounds.
 *
 * Split into its own module for the same reason `faucet-budget` was: the
 * rollover and the sweep are the only parts with arithmetic worth testing, and
 * `merchants.ts` cannot be imported in a unit test without a chain and a config.
 *
 * NOT a security boundary — in-process, so a restart resets it and two instances
 * get one ceiling each. It bounds casual abuse, which is the real threat to a
 * testnet registry.
 */
export type HandleBudgets = Map<string, BudgetState>;

export const emptyHandleBudgets = (): HandleBudgets => new Map();

export interface HandleReservation {
  ok: boolean;
  /** Milliseconds until this key's window rolls — for the retry hint. */
  resetInMs: number;
}

/**
 * Take one unit against `key`, sweeping keys whose window has already rolled.
 *
 * Swept on write rather than on a timer: an entry past its window is
 * indistinguishable from an absent one (both reserve from a fresh window), so
 * dropping it changes no decision. The key space is every handle anyone has
 * ever aimed at, which is unbounded once the route is open to the internet.
 *
 * Mutates `budgets`, deliberately — the caller holds one long-lived map and a
 * copy-on-write version of this would be a new map per request.
 */
export function reserveForHandle(
  budgets: HandleBudgets,
  key: string,
  limit: bigint,
  now: number,
  windowMs: number,
): HandleReservation {
  for (const [entry, state] of budgets) {
    if (now - state.windowStart >= windowMs) budgets.delete(entry);
  }
  const taken = reserve(budgets.get(key) ?? emptyBudget(), 1n, limit, now, windowMs);
  budgets.set(key, taken.state);
  return { ok: taken.ok, resetInMs: msUntilReset(taken.state, now, windowMs) };
}

/**
 * Give one unit back, for a request that changed nothing on-chain.
 *
 * Without this the share ratchets down on failed edits and a shop eventually
 * becomes uneditable by its own owner — the same failure the shared budget's
 * release prevents, one level down. A key swept between reserve and release is
 * simply absent, and re-creating it to credit a refund would resurrect a window
 * that has already rolled.
 */
export function releaseForHandle(budgets: HandleBudgets, key: string): void {
  const held = budgets.get(key);
  if (held) budgets.set(key, release(held, 1n));
}
