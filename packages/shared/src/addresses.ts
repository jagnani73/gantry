import type { Address } from "viem";

export const BASE_SEPOLIA_CHAIN_ID = 84532;

/**
 * MockUSDC is deliberately absent. It is still deployed (and the Foundry suite
 * uses it as a generic EIP-3009 test double), but nothing in the running app
 * resolves it — every door settles in real Circle USDC. Listing it here once
 * put a second USDC-looking address in front of an operator mid-demo.
 */
export interface GantryAddresses {
  gantryCore: Address;
  fixedRateSwap: Address;
  mockXsgd: Address;
  realUsdc: Address;
  agentPbmFactory: Address;
  demoAgentPbmWallet: Address;
}

/** Review-hardened redeploy, 5 Aug 2026; PBM contracts 7 Aug 2026. Basescan-verified. */
export const BASE_SEPOLIA_ADDRESSES: GantryAddresses = {
  gantryCore: "0x6F02501ed28Fe918b04fC285404C615f4Ab25Ce0",
  fixedRateSwap: "0xEdcD7AcABb610543e1626F4453c9c4Ec8ABab713",
  mockXsgd: "0xd583FaB0Db5c543f5574780f8b899AEb74463361",
  realUsdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  agentPbmFactory: "0x172905F26F09b41636854338360315971240c1cf",
  demoAgentPbmWallet: "0xDD4bbed78B64715288bf10fabB2b62c659299D3E",
};

/** GantryCore deploy block — indexer backfill floor. */
export const BASE_SEPOLIA_DEPLOY_BLOCK = 45065094n;

export const BASE_SEPOLIA_RELAYER: Address = "0x82513007C7eB93b54dC555Bdb74341b3084FC47B";

export const BASESCAN_BASE_URL = "https://sepolia.basescan.org";
