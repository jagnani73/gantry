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
}

export const TOKENS: Record<TokenId, TokenInfo> = {
  USDC: { id: "USDC", eip712: { name: "USDC", version: "2" } },
  MockXSGD: { id: "MockXSGD", eip712: { name: "Mock XSGD", version: "1" } },
};

/** The one enumeration of the token set. Derive from this — the ids used to be
 * re-listed in the boot assert and the request schema, which let a rename pass
 * tsc and still be wrong at runtime. */
export const TOKEN_IDS = Object.keys(TOKENS) as [TokenId, ...TokenId[]];

export function tokenAddress(addresses: GantryAddresses, id: TokenId): Address {
  return id === "USDC" ? addresses.realUsdc : addresses.mockXsgd;
}

export function tokenIdByAddress(addresses: GantryAddresses, address: Address): TokenId | null {
  const needle = address.toLowerCase();
  if (needle === addresses.realUsdc.toLowerCase()) return "USDC";
  if (needle === addresses.mockXsgd.toLowerCase()) return "MockXSGD";
  return null;
}
