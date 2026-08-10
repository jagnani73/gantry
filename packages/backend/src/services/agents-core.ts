import type { Address } from "viem";
import { categoryName, type AgentSummary, type TokenId } from "@gantry/shared";

/**
 * The pure half of the agent read path — raw chain values in, AgentSummary out,
 * no client and no config — so the shaping can be tested without a chain. Same
 * split as facilitator-core and pbm-core.
 */

/** One wallet's reads, exactly as the contracts return them. */
export interface RawAgentState {
  wallet: Address;
  /** Live `owner()`, not the factory's record of who created it — see agents.ts. */
  owner: Address;
  agentSigner: Address;
  /** `AgentPBMWallet.policy()`: dailyCap, perTxCap, expiry, categoryBitmap.
   * expiry is a uint40, which viem widens to a number rather than a bigint. */
  policy: readonly [bigint, bigint, number, bigint];
  spentToday: bigint;
  balance: bigint;
  token: TokenId;
  /** XSGD 6dp out per 1e6 token units — the OWNER-SET rate, not a market one. */
  rate: bigint;
  /** Unix seconds of the last `setPolicy`/`revoke`; 0 = never armed. */
  policyUpdatedAt: number;
  /** The owner's display name, or "" when unnamed. */
  label: string;
}

/**
 * Names for every set bit. GantryCore caps categoryId < 256, so no higher bit
 * can ever gate a real merchant. An id inside that range that the registry does
 * not know still renders (`category_7`) instead of vanishing: the owner allowed
 * it, so the owner has to be able to see that they did.
 */
export function decodeCategories(bitmap: bigint): string[] {
  const names: string[] = [];
  for (let id = 0; id < 256; id++) {
    if ((bitmap >> BigInt(id)) & 1n) names.push(categoryName(id));
  }
  return names;
}

/** Case-insensitive address equality. Addresses arrive from three spellings —
 * a query string, a route segment and a chain read — and only the last is
 * reliably checksummed. */
export function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function toAgentSummary(raw: RawAgentState): AgentSummary {
  const [dailyCap, perTxCap, expiry, categoryBitmap] = raw.policy;
  return {
    wallet: raw.wallet,
    owner: raw.owner,
    agentSigner: raw.agentSigner,
    dailyCap: dailyCap.toString(),
    perTxCap: perTxCap.toString(),
    spentToday: raw.spentToday.toString(),
    expiry: Number(expiry),
    categoryBitmap: categoryBitmap.toString(),
    categories: decodeCategories(categoryBitmap),
    token: raw.token,
    balance: raw.balance.toString(),
    rate: raw.rate.toString(),
    // Derived, and never a second source of truth: the contract has no revoked
    // flag — revoke() just zeroes expiry. A policy that merely LAPSED denies
    // every spend with this still false, which is why a status badge must come
    // from agentStatus() and not from here.
    revoked: Number(expiry) === 0,
    policyUpdatedAt: raw.policyUpdatedAt,
    label: raw.label,
  };
}
