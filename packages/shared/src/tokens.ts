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

/**
 * Fields of `GantryAddresses` that hold a TOKEN address.
 *
 * Constrained rather than `keyof GantryAddresses` so a token cannot be pointed
 * at `gantryCore` or the factory, which are addresses of the same shape and
 * would fail only at settle time.
 */
export type TokenAddressKey = "realUsdc" | "mockXsgd";

export interface TokenInfo {
  id: TokenId;
  /**
   * Where this token's address lives on `GantryAddresses`.
   *
   * Here rather than in a `switch` inside `tokenAddress` because the resolver
   * used to be a two-branch ternary with an implicit else — every id that was
   * not `USDC` silently resolved to MockXSGD, so a third token would have
   * quoted a payer in one asset and taken authorization against another. A
   * table entry makes adding a token a data change that cannot have an else.
   */
  addressKey: TokenAddressKey;
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
  USDC: {
    id: "USDC",
    addressKey: "realUsdc",
    eip712: { name: "USDC", version: "2" },
    payable: true,
  },
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
  MockXSGD: {
    id: "MockXSGD",
    addressKey: "mockXsgd",
    eip712: { name: "Mock XSGD", version: "1" },
    payable: false,
  },
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
  return addresses[TOKENS[id].addressKey];
}

/**
 * Reverse lookup, over the whole table rather than a hand-written if-chain.
 *
 * Returns null for anything unknown, and every caller treats that as a refusal
 * (`unknown_asset` on the facilitator, a null `tokenSymbol` on a swept row) —
 * so a token this build does not know is declined rather than guessed at.
 */
export function tokenIdByAddress(addresses: GantryAddresses, address: Address): TokenId | null {
  const needle = address.toLowerCase();
  return TOKEN_IDS.find((id) => addresses[TOKENS[id].addressKey].toLowerCase() === needle) ?? null;
}
