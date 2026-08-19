import type { TokenId } from "./tokens";

/**
 * Its OWN module, with a type-only import and nothing else.
 *
 * `scripts/demo-reset.mjs` is one of the three callers and runs under node's
 * type stripping, which does not rewrite specifiers — so it can only load a
 * shared module that has no VALUE imports of its own. `import type` is erased
 * entirely, so this file is reachable from there while `agentCurrency.ts`,
 * which imports the token table for real, is not. That constraint is why the
 * rule does not simply live beside `resolveAgentCurrency`.
 */
/**
 * Which of several wallets an agent signer will actually spend from.
 *
 * CURRENCY FIRST, then newest-active. An agent wallet spends one token — its
 * caps are a single number in that token's units — so a wallet holding euros
 * cannot pay a dollar order at all, and preferring it because it happened to be
 * newest is how a working setup starts failing `agent_currency_mismatch` the
 * moment a second wallet exists.
 *
 * HERE, rather than in the agent CLI, because THREE places apply this rule and
 * they must agree: the CLI resolving its own wallet, `demo-reset` provisioning
 * one, and `demo-reset`'s step 6b checking that the CLI will pick what it just
 * armed. They have drifted before — the script armed one wallet while the CLI
 * spent from another, and a lagging 6b printed a false mismatch warning, which
 * is how a presenter learns to ignore warnings. Nothing but comments coupled
 * them, and a comment is not a mechanism.
 *
 * Falls back to ALL candidates rather than to none, twice over: a wallet that
 * holds nothing reports the default token, and the on-chain balance check is
 * the right thing to refuse it — by name, at the moment it matters.
 *
 * @param isActive liveness, injected so this module stays free of a clock. Pass
 *   `(a) => agentStatus(a, now) === "active"`.
 * @returns the chosen wallet, or null when there are no candidates at all.
 */
export function selectAgentWallet<T extends { token: TokenId }>(
  candidates: readonly T[],
  wanted: TokenId,
  isActive: (candidate: T) => boolean,
): T | null {
  const spendsMine = candidates.filter((c) => c.token === wanted);
  const pool = spendsMine.length > 0 ? spendsMine : candidates;
  const active = pool.filter(isActive);
  return active.at(-1) ?? pool.at(-1) ?? null;
}
