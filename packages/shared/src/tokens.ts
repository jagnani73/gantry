import type { Address } from "viem";
import type { GantryAddresses } from "./addresses";

/** Wire identifier for a pay token. MUSDC = MockUSDC, USDC = real Circle testnet USDC. */
export type TokenId = "MUSDC" | "USDC" | "XSGD";

export interface TokenInfo {
  id: TokenId;
  symbol: string;
  decimals: 6;
  /**
   * Pinned EXPECTED EIP-712 domain (name/version). The backend reads
   * name()/version() live at boot and asserts equality — fail fast on drift.
   * Real USDC values fork-test-confirmed ("USDC", "2").
   */
  eip712: { name: string; version: string };
}

export const TOKENS: Record<TokenId, TokenInfo> = {
  MUSDC: { id: "MUSDC", symbol: "USDC", decimals: 6, eip712: { name: "Mock USDC", version: "1" } },
  USDC: { id: "USDC", symbol: "USDC", decimals: 6, eip712: { name: "USDC", version: "2" } },
  XSGD: { id: "XSGD", symbol: "XSGD", decimals: 6, eip712: { name: "Mock XSGD", version: "1" } },
};

export function tokenAddress(addresses: GantryAddresses, id: TokenId): Address {
  switch (id) {
    case "MUSDC":
      return addresses.mockUsdc;
    case "XSGD":
      return addresses.mockXsgd;
    case "USDC": {
      if (!addresses.realUsdc) throw new Error("real USDC is not available on this chain");
      return addresses.realUsdc;
    }
  }
}

export function tokenIdByAddress(addresses: GantryAddresses, address: Address): TokenId | null {
  const needle = address.toLowerCase();
  if (needle === addresses.mockUsdc.toLowerCase()) return "MUSDC";
  if (needle === addresses.mockXsgd.toLowerCase()) return "XSGD";
  if (addresses.realUsdc && needle === addresses.realUsdc.toLowerCase()) return "USDC";
  return null;
}
