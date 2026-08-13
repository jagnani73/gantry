import type { Address } from "viem";
import type { GantryAddresses } from "./addresses";

/**
 * Two tokens, and the ids say which is which.
 *
 * `USDC` is Circle's real testnet contract — payers really do sign EIP-3009
 * authorizations against it. There is no mock USD token: MockUSDC existed only
 * because it has an open mint, and funding a payer now means the relayer
 * *transferring* real USDC instead.
 *
 * `MockXSGD` is a mock and is named so it cannot be mistaken for anything else.
 * Real XSGD exists on no testnet — only on mainnet via StraitsX — so it is the
 * one thing here that cannot be un-mocked.
 */
export type TokenId = "USDC" | "MockXSGD";

export interface TokenInfo {
  id: TokenId;
  /**
   * Pinned EXPECTED EIP-712 domain (name/version) — the values the deployed
   * contracts return. The backend reads name()/version() live at boot and
   * asserts equality, so drift fails fast instead of at signing time.
   */
  eip712: { name: string; version: string };
  /**
   * May a payer be QUOTED in this token — i.e. may it be an intent's `tokenIn`?
   *
   * A property of the token rather than a list kept somewhere else, so adding a
   * token forces the decision instead of inheriting a default.
   */
  payable: boolean;
}

export const TOKENS: Record<TokenId, TokenInfo> = {
  USDC: { id: "USDC", eip712: { name: "USDC", version: "2" }, payable: true },
  /**
   * NOT payable, and this is a security boundary rather than a product choice.
   *
   * MockXSGD's `mint()` is public and unguarded — it has to be, it is the mock
   * that stands in for a token existing on no testnet, and demo provisioning
   * mints it. It is also the SETTLEMENT token, and `GantryCore.createIntent`
   * accepts it as `tokenIn` for XSGD-direct payments that skip the swap.
   *
   * Together those make a free settlement: mint yourself any amount, take an
   * XSGD-denominated intent, sign an EIP-3009 authorization against the mock,
   * and a fabricated payment lands on any merchant's live book at zero cost —
   * while costing the relayer a createIntent tx per attempt. `createIntent` is
   * onlyRelayer on-chain, so refusing to quote it here closes the path
   * completely without touching a deployed contract.
   */
  MockXSGD: { id: "MockXSGD", eip712: { name: "Mock XSGD", version: "1" }, payable: false },
};

/** The one enumeration of the token set. Derive from this — the ids used to be
 * re-listed in the boot assert and the request schema, which let a rename pass
 * tsc and still be wrong at runtime. */
export const TOKEN_IDS = Object.keys(TOKENS) as [TokenId, ...TokenId[]];

/**
 * The subset a caller may ask to be quoted in. Derived, so a token added above
 * cannot become payable by omission — only by saying so.
 */
export const PAYABLE_TOKEN_IDS = TOKEN_IDS.filter((id) => TOKENS[id].payable) as [
  TokenId,
  ...TokenId[],
];

/** Is this token one a payer may be quoted in? The guard behind the schema. */
export function isPayableToken(id: TokenId): boolean {
  return TOKENS[id].payable;
}

export function tokenAddress(addresses: GantryAddresses, id: TokenId): Address {
  return id === "USDC" ? addresses.realUsdc : addresses.mockXsgd;
}

export function tokenIdByAddress(addresses: GantryAddresses, address: Address): TokenId | null {
  const needle = address.toLowerCase();
  if (needle === addresses.realUsdc.toLowerCase()) return "USDC";
  if (needle === addresses.mockXsgd.toLowerCase()) return "MockXSGD";
  return null;
}
