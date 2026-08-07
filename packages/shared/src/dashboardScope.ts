/**
 * Dashboard feed scoping. `/dashboard?handle=<h>` narrows the live feed to one
 * merchant — what a shop that just onboarded wants to see. Pure so the rules
 * can be tested; the component only wires them up.
 *
 * The failure this guards against is silent: an unmatchable scope renders a
 * perfectly healthy-looking dashboard that simply never shows a payment. Empty
 * and whitespace-only values are therefore treated as "no scope" rather than as
 * a handle nothing can match.
 */

/** URL param → scope, or null for "all merchants". */
export function resolveScope(param: string | null | undefined): string | null {
  if (param === null || param === undefined) return null;
  // Handles are lowercase on-chain (HANDLE_REGEX), so a shared or hand-typed
  // "?handle=Ah-Hock-Chicken-Rice" should scope, not silently match nothing.
  const trimmed = param.trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}

export function visibleRows<T extends { handle: string }>(
  rows: readonly T[],
  scope: string | null,
): readonly T[] {
  return scope === null ? rows : rows.filter((row) => row.handle === scope);
}

/** A settlement the current scope hides must never ring the chime. */
export function shouldChime(live: boolean, rowHandle: string, scope: string | null): boolean {
  return live && (scope === null || rowHandle === scope);
}
