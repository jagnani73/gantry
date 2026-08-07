import type { Address } from "viem";

export const BASE_SEPOLIA_CHAIN_ID = 84532;

export interface GantryAddresses {
  gantryCore: Address;
  fixedRateSwap: Address;
  mockUsdc: Address;
  mockXsgd: Address;
  realUsdc: Address | null;
  /** M3 PBM contracts — nullable (like realUsdc) so the Anvil branch stays valid. */
  agentPbmFactory: Address | null;
  demoAgentPbmWallet: Address | null;
}

/** Review-hardened redeploy, 5 Aug 2026; PBM contracts 7 Aug 2026. Basescan-verified. */
export const BASE_SEPOLIA_ADDRESSES: GantryAddresses = {
  gantryCore: "0x6F02501ed28Fe918b04fC285404C615f4Ab25Ce0",
  fixedRateSwap: "0xEdcD7AcABb610543e1626F4453c9c4Ec8ABab713",
  mockUsdc: "0x5F7F058F2B1572524d1E3E740656CfAd1Ab011F9",
  mockXsgd: "0xd583FaB0Db5c543f5574780f8b899AEb74463361",
  realUsdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  agentPbmFactory: "0x172905F26F09b41636854338360315971240c1cf",
  demoAgentPbmWallet: "0xDD4bbed78B64715288bf10fabB2b62c659299D3E",
};

/** GantryCore deploy block — indexer backfill floor. */
export const BASE_SEPOLIA_DEPLOY_BLOCK = 45065094n;

export const BASE_SEPOLIA_RELAYER: Address = "0x82513007C7eB93b54dC555Bdb74341b3084FC47B";

export const BASESCAN_BASE_URL = "https://sepolia.basescan.org";
