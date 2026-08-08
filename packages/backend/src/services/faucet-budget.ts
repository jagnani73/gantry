/**
 * A rolling-window spend ceiling, counted across ALL callers.
 *
 * The faucet's per-address cooldown bounds one browser, not one attacker: fresh
 * addresses are free, so on a public host the grant loop is unbounded. A global
 * ceiling is the missing half — it makes the worst case a number we choose
 * rather than the funder's whole balance.
 *
 * Pure and separate from `faucet.ts` because the window rollover is the only
 * part with arithmetic worth testing, and `faucet.ts` cannot be imported in a
 * unit test without a chain.
 *
 * NOT a security boundary: state is in-process, so a restart resets it and two
 * instances get one ceiling each. It bounds accidental and casual abuse, which
 * is the actual threat to a testnet faucet whose asset has no market value.
 */
export interface BudgetState {
  /** Start of the current window, ms. 0 = no window open yet. */
  windowStart: number;
  /** Reserved within the current window, token units. */
  spent: bigint;
}

export const emptyBudget = (): BudgetState => ({ windowStart: 0, spent: 0n });

export interface Reservation {
  ok: boolean;
  state: BudgetState;
  /** Units still available after this call — for the error message. */
  remaining: bigint;
}

/**
 * Reserve `amount` against `budget`. `budget === null` means unmetered (the demo
 * host, where rehearsals need to fund freely).
 *
 * Reserves BEFORE the spend rather than recording after it, so concurrent
 * requests cannot both pass the check and overshoot the ceiling. Callers must
 * `release()` if the spend then fails.
 */
export function reserve(
  state: BudgetState,
  amount: bigint,
  budget: bigint | null,
  now: number,
  windowMs: number,
): Reservation {
  if (budget === null) return { ok: true, state, remaining: 0n };

  // A window opens on its first reservation and runs `windowMs` from there —
  // deliberately not calendar days, which would hand a full budget to anyone
  // waiting for midnight in whatever timezone the host happens to be in.
  const rolled = state.windowStart === 0 || now - state.windowStart >= windowMs;
  const base: BudgetState = rolled ? { windowStart: now, spent: 0n } : state;

  if (base.spent + amount > budget) {
    return { ok: false, state: base, remaining: budget - base.spent };
  }
  return {
    ok: true,
    state: { windowStart: base.windowStart, spent: base.spent + amount },
    remaining: budget - base.spent - amount,
  };
}

/** Give a reservation back after a failed spend. Never goes below zero. */
export function release(state: BudgetState, amount: bigint): BudgetState {
  return { ...state, spent: state.spent > amount ? state.spent - amount : 0n };
}

/** Whole milliseconds until the current window rolls — for the retry hint. */
export function msUntilReset(state: BudgetState, now: number, windowMs: number): number {
  if (state.windowStart === 0) return 0;
  return Math.max(0, state.windowStart + windowMs - now);
}
