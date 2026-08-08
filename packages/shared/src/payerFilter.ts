import { isAddress, type Address } from "viem";

/**
 * The `payer` filter on `GET /api/settlements` — a comma-separated address
 * list, matched against a row's `payer` OR its `agentPayer`.
 *
 * The OR is the whole point. A PBM payment's on-chain payer is the agent's
 * wallet and a bridged x402 payment's is the relayer, so a payer app that
 * filtered on the human's address alone would show them an activity feed
 * missing every payment their agents made on their behalf.
 *
 * The backend turns the parsed list into an IN-list; `matchesPayerFilter` below
 * is the row-side half of the same rule, for a caller holding rows already.
 * NOTHING calls it today — the payer app fetches a filtered page rather than
 * sifting one client-side, and it has no SSE stream to sift.
 *
 * EIP-55 is deliberately NOT enforced here, unlike a payout address. A filter
 * is a read: the worst a wrong one does is return no rows, nothing is
 * misrouted, and the casing is normalised away a line later anyway — so
 * rejecting the all-uppercase form some tools emit would cost more than it
 * catches.
 */

/** Bounds the IN-list the backend builds. A payer with more agents than this
 * needs a different screen, not a longer URL. */
export const MAX_PAYER_FILTER = 20;

export type PayerFilterResult =
  /** `payers === null` means "no filter" — every row matches. A non-null list
   * is never empty and always lowercase. */
  | { ok: true; payers: readonly Address[] | null }
  | { ok: false; reason: "empty" | "malformed" | "too_many"; message: string };

/**
 * Absent (null/undefined) is "no filter". A param that is PRESENT but names
 * nobody (`?payer=`, `?payer=,,`) is an error, not a shrug: the two plausible
 * fallbacks are both wrong in a way nobody would notice on stage — "match
 * everything" puts strangers' payments in Your Activity, and "match nothing"
 * renders a healthy-looking empty feed that is indistinguishable from a payer
 * who has never paid. Refusing is the only answer that says what happened.
 */
export function parsePayerFilter(raw: string | null | undefined): PayerFilterResult {
  if (raw === null || raw === undefined) return { ok: true, payers: null };

  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) {
    return {
      ok: false,
      reason: "empty",
      message: "payer filter was supplied but lists no addresses — omit it to match every payer",
    };
  }
  // Capped on the raw item count, before any per-item work: the cap exists to
  // bound the query, so duplicates count towards it too.
  if (parts.length > MAX_PAYER_FILTER) {
    return {
      ok: false,
      reason: "too_many",
      message: `payer filter accepts at most ${MAX_PAYER_FILTER} addresses, got ${parts.length}`,
    };
  }

  const payers: Address[] = [];
  for (const part of parts) {
    if (!isAddress(part, { strict: false })) {
      return {
        ok: false,
        reason: "malformed",
        message: `payer filter entry is not a wallet address: ${JSON.stringify(part)}`,
      };
    }
    const lower = part.toLowerCase() as Address;
    if (!payers.includes(lower)) payers.push(lower);
  }
  return { ok: true, payers };
}

/**
 * "Is this row in this filter" — the predicate `?payer=` compiles to in SQL,
 * for a caller that already holds the rows. Case-insensitive on both sides so a
 * caller that skipped `parsePayerFilter` still gets the right answer.
 *
 * UNUSED so far, and do NOT reach for it as "the client-side payer filter": the
 * payer app's `isOwnPayment` (components/payer/activity.ts) answers a different
 * question and deliberately NEGATES on `agentPayer` where this ORs on it. That
 * one is "I paid this myself", which excludes agent spending; this one is "my
 * address is on it", which is what the agents screen and the history endpoint
 * mean by mine. Same field, opposite semantics — pick by the question, and never
 * swap one for the other to remove a duplicate.
 */
export function matchesPayerFilter(
  row: { payer: Address; agentPayer?: Address | null },
  payers: readonly Address[] | null,
): boolean {
  if (payers === null) return true;
  const payer = row.payer.toLowerCase();
  const agentPayer = row.agentPayer ? row.agentPayer.toLowerCase() : null;
  return payers.some((candidate) => {
    const needle = candidate.toLowerCase();
    return needle === payer || needle === agentPayer;
  });
}
