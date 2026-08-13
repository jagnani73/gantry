import { ApiError } from "../errors";

/**
 * Bounds CONCURRENT unauthenticated work per caller.
 *
 * Every relayer write serialises through one FIFO nonce queue, and that queue is
 * unbounded. So a caller firing intent creations in parallel does not merely
 * spend the gas key — it puts arbitrarily many transactions in front of a real
 * payment, and an intent that waits past its 600s TTL is a payer watching a QR
 * screen fail for reasons nothing on it can explain.
 *
 * Deliberately a concurrency guard rather than a cooldown. A cooldown is the
 * obvious reach and the wrong one here: venue NAT collapses every visitor to one
 * key (a room onboarding shops already shares the 30s register cooldown), and a
 * presenter paying twice in a row on stage would be 429'd by their own previous
 * payment. A human never has two intent creations in flight at once; a flood is
 * exactly that and nothing else. So this bounds the abuse shape without a timer
 * that can refuse a legitimate second payment.
 *
 * Residual, stated rather than papered over: one caller can still issue requests
 * serially as fast as round-trips allow, and many IPs can still flood together.
 * This is faucet trust level, as the routes themselves say — it is a bound on
 * the cheapest amplification, not authentication.
 */
export interface InFlightGuard {
  /** Runs `work` while holding the slot for `key`, releasing on every path. */
  run<T>(key: string | undefined, work: () => Promise<T>): Promise<T>;
}

export function inFlightGuard(errorName: string, message: string): InFlightGuard {
  const active = new Set<string>();
  return {
    async run<T>(key: string | undefined, work: () => Promise<T>): Promise<T> {
      // An absent IP collapses to one shared key rather than to "unguarded" —
      // failing open here would make the guard removable by stripping a header.
      const slot = key ?? "unknown";
      if (active.has(slot)) throw new ApiError(429, errorName, message);
      active.add(slot);
      try {
        return await work();
      } finally {
        active.delete(slot);
      }
    },
  };
}
