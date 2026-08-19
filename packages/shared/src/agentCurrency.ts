import { PAYABLE_TOKEN_IDS, VANILLA_DEFAULT_TOKEN, type TokenId } from "./tokens";

/**
 * Which currency an agent spends — derived from what it HOLDS, not stored.
 *
 * `AgentPBMWallet` has no field for this and cannot get one without redeploying
 * all four contracts, so the alternative to deriving it is a table somewhere
 * off-chain. That would be worse than absent: agent wallets are payer-owned and
 * enumerated from factory logs, so a per-host record of "this one is a euro
 * agent" is exactly the kind of state that makes two hosts disagree about
 * someone's spending rules.
 *
 * The balance answers it instead, and answers it the same way everywhere.
 *
 * ONE currency per agent is a real constraint, not a simplification. The policy
 * is a single `dailyCap`, a single `perTxCap` and a single `_spentToday`
 * counter, all in "the spend token's own 6dp units" — so a wallet spending two
 * tokens counts €1 as $1. At 1.51 against 1.3421 XSGD that is ~13% wrong, and
 * wrong silently, on the one number this product promises the chain enforces.
 * The contract's own docstring says as much.
 */

export type AgentCurrency = {
  /** What its caps are denominated in, and what a spend must be quoted in. */
  token: TokenId;
  /**
   * It holds MORE THAN ONE payable token, so the caps are ambiguous.
   *
   * Not an error state to hide: the wallet is real, the funds are real, and the
   * daily counter is genuinely conflating them. Surfaced so a screen can say so
   * and the PBM door can refuse, rather than picking one and rendering a cap
   * that is wrong for the other.
   */
  ambiguous: boolean;
  /** Every payable token this wallet actually holds a non-zero balance of, in
   * `PAYABLE_TOKEN_IDS` order. Empty for an unfunded wallet — which is why
   * `token` above is a DEFAULT there and not an observation. */
  held: readonly TokenId[];
};

/**
 * @param balances Every payable token's balance for this wallet. Missing keys
 *   count as zero, so a caller that could only read one token still gets an
 *   answer rather than an exception.
 */
export function resolveAgentCurrency(balances: Partial<Record<TokenId, bigint>>): AgentCurrency {
  const held = PAYABLE_TOKEN_IDS.filter((id) => (balances[id] ?? 0n) > 0n);
  // An unfunded wallet is the common case — freshly created, or drained by the
  // demo. It is not ambiguous, it simply has no evidence yet, and defaulting
  // keeps every screen and every quote on the same token until it is funded.
  // VANILLA_DEFAULT_TOKEN, not PAYABLE_TOKEN_IDS[0]: that order comes from the
  // key order of the TOKENS object, so tidying the registry would silently move
  // every unfunded wallet onto a different currency — relabelling its caps and
  // sending topUpPbmWallet after the wrong token — with nobody touching this
  // file. tokens.ts states the rule for exactly this reason.
  if (held.length === 0) return { token: VANILLA_DEFAULT_TOKEN, ambiguous: false, held: [] };
  return { token: held[0]!, ambiguous: held.length > 1, held };
}

/**
 * May this wallet be asked to spend this token?
 *
 * The rule the PBM door enforces, kept beside the resolver so the check and the
 * display can never disagree about what an agent's currency is. A wallet
 * holding nothing may be quoted in anything — it will fail the balance check
 * on-chain, which is the correct and specific refusal.
 */
export function canAgentSpend(
  balances: Partial<Record<TokenId, bigint>>,
  token: TokenId,
): { ok: true } | { ok: false; reason: string } {
  // Computed here rather than read off `resolveAgentCurrency`, because that
  // function DEFAULTS an empty wallet to USDC for display — and a default is
  // not evidence. Treating it as evidence refused a euro payment from a wallet
  // that held nothing at all, which is the on-chain balance check's job to
  // refuse, by name.
  const held = PAYABLE_TOKEN_IDS.filter((id) => (balances[id] ?? 0n) > 0n);
  if (held.length > 1) {
    return {
      ok: false,
      reason:
        "this wallet holds more than one payable token, so its daily cap counts them as if they " +
        "were worth the same. Withdraw one before spending the other.",
    };
  }
  // Nothing held: there is no denomination to contradict. The spend fails
  // on-chain with InsufficientWalletBalance, which names the real problem —
  // a client-side "wrong currency" here would name the wrong one.
  if (held.length === 0) return { ok: true };
  if (held[0] !== token) {
    return {
      ok: false,
      reason: `this wallet spends ${held[0]}; a ${token} payment would be counted against a cap denominated in ${held[0]}`,
    };
  }
  return { ok: true };
}
