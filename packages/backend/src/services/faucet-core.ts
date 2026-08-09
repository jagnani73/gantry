import { emptyBudget, msUntilReset, release, reserve, type BudgetState } from "./faucet-budget";

/**
 * The pure half of the payer faucet, split out for the same reason
 * faucet-budget.ts is: faucet.ts cannot be imported without a chain, and the
 * rules here are what keep an unauthenticated route away from the only gas key
 * in the system.
 *
 * It owns the NUMBERS as well as the rules. The two ceilings and the two grant
 * sizes are one arithmetic story — "five of each per day" — and that story is
 * only checkable if the constants and the code that divides them live somewhere
 * a unit test can import. config.ts calls `faucetCeilings` and surfaces both
 * values on `config` (the boot banner announces both on a public host); it
 * declares no number of its own. Its doc comments do retell this arithmetic in
 * prose, so those sentences are the part that can rot — the VALUES cannot
 * disagree, because there is only one set of them and it is here.
 */

/** Must cover the LARGEST single payment a funded payer makes, because the
 * payer page funds once and then signs: the agent-door order is S$4.50 ≈ 3.35
 * USDC, and the payer page's S$5 demo-account cap (≈ 3.73 USDC) is deliberately
 * set just under this grant so one grant always suffices. */
export const GRANT = 4_000_000n; // 4 USDC

/**
 * Where the payer's ETH balance is topped up to. Enough for the owner
 * transactions an agent needs — one `createWallet` (a contract deployment, the
 * expensive one) plus several `setPolicy`/`revoke` calls at Base Sepolia's fees,
 * with room for the L1 data component to move.
 */
export const ETH_TARGET = 2_000_000_000_000_000n; // 0.002 ETH

/**
 * ETH the relayer must still hold after a top-up. Matches MIN_ETH_RESERVE in
 * services/funder.ts on purpose: it is the same key and the same question, and
 * two different floors on one balance would be two different wrong answers.
 */
export const FUNDER_ETH_RESERVE = 50_000_000_000_000_000n; // 0.05 ETH

/** Rolling, from the first reservation of each leg's window. */
export const BUDGET_WINDOW_MS = 86_400_000; // 24h

/** Per-address, per-leg. The USDC one bounds a flat grant, so it is the half
 * that actually prevents loss on an unprovable transfer. */
export const USDC_COOLDOWN_MS = 60_000;
/**
 * The gas leg's own cooldown, deliberately a SECOND map rather than a second
 * reader of the USDC one. Sharing it is what made a payment 30 seconds ago able
 * to refuse the gas an agent revoke needs.
 *
 * It bounds less than the USDC cooldown does, because a top-up is idempotent by
 * shape: asking again while the balance is already at target sends nothing at
 * all. It only matters against an address that keeps SPENDING what it is given.
 */
export const GAS_COOLDOWN_MS = 60_000;

/**
 * Rolling-24h ceiling on payer funding across ALL addresses, on a public host.
 * Five grants: enough for a Q&A, and a loss the ETH→USDC top-up swap in
 * services/funder.ts can replace.
 */
export const PUBLIC_USDC_DAILY_BUDGET = 20_000_000n; // 5 × GRANT
/**
 * The gas leg's ceiling, in WEI. Five full top-ups, matching the USDC leg's
 * five grants, so neither leg is the loose one. The number that matters is what
 * is LEFT: this ETH is the only gas key in the system and it pays for every
 * door, so 0.01 is a fifth of the 0.05 reserve services/funder.ts already
 * refuses to swap below.
 */
export const PUBLIC_GAS_DAILY_BUDGET = 10_000_000_000_000_000n; // 5 × ETH_TARGET

export interface FaucetCeilings {
  /** 6dp USDC units per rolling window, or null for unmetered. */
  usdc: bigint | null;
  /** Wei per rolling window, or null for unmetered. */
  gas: bigint | null;
}

/**
 * Both ceilings from one host decision, so the demo/public rule is applied in
 * exactly one place. Unmetered on a demo host: a rehearsal pass alone spends two
 * USDC grants (`e2e:pay` + `x402:buy`) and funds several addresses, so ten
 * rehearsals would blow any sane ceiling.
 */
export function faucetCeilings(isDemoHost: boolean): FaucetCeilings {
  if (isDemoHost) return { usdc: null, gas: null };
  return { usdc: PUBLIC_USDC_DAILY_BUDGET, gas: PUBLIC_GAS_DAILY_BUDGET };
}

/**
 * How much ETH to send so `balance` reaches `target` — zero when it already
 * does.
 *
 * A TOP-UP, never a per-call grant. A flat grant would let one payer walk the
 * relayer's ETH away a tap at a time (a reload, a second device, a loop), and
 * top-up shape is also what makes an unconfirmable send self-correcting: if the
 * transaction we could not prove did land, the next call reads the higher
 * balance and sends nothing at all.
 */
export function gasTopUpAmount(balance: bigint, target: bigint): bigint {
  return balance >= target ? 0n : target - balance;
}

/**
 * Whether the funder may send `amount` and still hold `reserve` afterwards.
 *
 * The relayer's ETH is not one affordance's budget — it is the ONLY gas key, and
 * it pays for QR settlement, x402 settlement, intent creation and merchant
 * registration alike. Draining it does not degrade the demo, it stops every door
 * at once. So the guard is a floor on what is LEFT rather than a ceiling on what
 * a single call may spend; the ceiling is the rolling budget, and these bound
 * different failure modes.
 */
export function funderCanSend(funderBalance: bigint, amount: bigint, reserve: bigint): boolean {
  return funderBalance >= amount + reserve;
}

/** Why a leg would not hand anything out. Carries the numbers the caller needs
 * to say so in a sentence — no leg composes its own HTTP error, because the two
 * legs word theirs differently on purpose. */
export type LegRefusal =
  | { kind: "cooldown"; retryInMs: number }
  | { kind: "in_flight" }
  | { kind: "budget"; remaining: bigint; resetInMs: number };

/**
 * One faucet leg's whole rate-limiting state: a rolling ceiling across every
 * caller, a per-address cooldown, and a per-address in-flight guard.
 *
 * Bundled because the three are only correct together, and because bundling is
 * what makes "the legs are independent" a fact a test can check rather than a
 * comment. Every field a leg has is created per-leg by `createFaucetLeg`.
 */
export interface FaucetLeg {
  /**
   * Cooldown → in-flight → budget, in that order; null means "go ahead".
   *
   * On success the key is marked in-flight and the budget is RESERVED (not
   * recorded after the fact), so concurrent requests cannot both pass and
   * overshoot the ceiling. Callers must `finish()` in a finally, and `release()`
   * only when the spend is PROVEN not to have happened.
   */
  claim(key: string, amount: bigint, now: number): LegRefusal | null;
  /** Hand a reservation back after a spend that provably did not happen. */
  release(amount: bigint): void;
  /** Arm the per-address cooldown. Deliberately separate from `claim`: a
   * refused or failed attempt must surface its real error on retry, never a
   * bogus 429. */
  armCooldown(key: string, now: number): void;
  /** Always, in a finally — a key left in flight is refused forever. */
  finish(key: string): void;
}

export function createFaucetLeg(
  budget: bigint | null,
  cooldownMs: number,
  windowMs: number = BUDGET_WINDOW_MS,
): FaucetLeg {
  const lastGranted = new Map<string, number>();
  const inFlight = new Set<string>();
  let state: BudgetState = emptyBudget();

  return {
    claim(key, amount, now) {
      const last = lastGranted.get(key);
      if (last !== undefined && now - last < cooldownMs) {
        return { kind: "cooldown", retryInMs: cooldownMs - (now - last) };
      }
      // The cooldown alone only rate-limits strictly SERIAL requests, because it
      // is armed after the transfer confirms — so N parallel requests for one
      // address would all pass it and each spend. Same reasoning as
      // `registerInFlight` in merchants.ts, and it matters more here.
      if (inFlight.has(key)) return { kind: "in_flight" };

      const reservation = reserve(state, amount, budget, now, windowMs);
      if (!reservation.ok) {
        // Deliberately NOT committing `reservation.state` here. On the rolled
        // path it carries a fresh `windowStart` with nothing spent, so
        // committing it on a REFUSAL would restart the 24h countdown every time
        // someone is turned away — `resetInMs` would advertise a full day,
        // forever, for a condition that never improves. Only a granted
        // reservation may move the window.
        return {
          kind: "budget",
          remaining: reservation.remaining,
          resetInMs: msUntilReset(reservation.state, now, windowMs),
        };
      }
      state = reservation.state;
      inFlight.add(key);
      return null;
    },
    release(amount) {
      state = release(state, amount);
    },
    armCooldown(key, now) {
      lastGranted.set(key, now);
    },
    finish(key) {
      inFlight.delete(key);
    },
  };
}

export interface FaucetLegs {
  /** The payment spine: a flat 4 USDC grant. */
  usdc: FaucetLeg;
  /** Gas for the transactions the payer OWNS (`createWallet`, `setPolicy`,
   * `revoke`). Paying a merchant is still gasless. */
  gas: FaucetLeg;
}

/**
 * Both legs from one host decision — the only place either ceiling is wired to
 * a leg.
 *
 * Built as a pair on purpose. Pointing the gas leg at the USDC ceiling is a
 * one-character mistake (20,000,000 units vs 2×10¹⁵ wei) that silently refuses
 * every gas top-up on a public host without either leg throwing, and it can only
 * be caught by a test if the wiring lives somewhere a test can call.
 */
export function createFaucetLegs(isDemoHost: boolean): FaucetLegs {
  const ceilings = faucetCeilings(isDemoHost);
  return {
    usdc: createFaucetLeg(ceilings.usdc, USDC_COOLDOWN_MS),
    gas: createFaucetLeg(ceilings.gas, GAS_COOLDOWN_MS),
  };
}
