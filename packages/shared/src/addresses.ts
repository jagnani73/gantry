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
}

/**
 * Review-hardened redeploy, 5 Aug 2026; PBM contracts 7 Aug 2026; agent factory
 * redeployed 10 Aug 2026 for the on-chain `label` and `policyUpdatedAt`.
 * Basescan-verified.
 *
 * `demoAgentPbmWallet` used to sit here and is GONE, not merely stale. It was a
 * relayer-owned wallet from `DeployPBM.s.sol`, already labelled historical when
 * agents became payer-owned; the factory redeploy finished it off twice over —
 * it is invisible to enumeration (a different factory's logs) and predates the
 * wallet ABI everything now reads. Provisioning a usable wallet is
 * `pnpm demo:reset`.
 */
export const BASE_SEPOLIA_ADDRESSES: GantryAddresses = {
  gantryCore: "0x6F02501ed28Fe918b04fC285404C615f4Ab25Ce0",
  fixedRateSwap: "0xEdcD7AcABb610543e1626F4453c9c4Ec8ABab713",
  mockXsgd: "0xd583FaB0Db5c543f5574780f8b899AEb74463361",
  realUsdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  agentPbmFactory: "0xd827C3445660a4D2d68c5D411DAbAE71B7fdcA05",
};

/** GantryCore deploy block — indexer backfill floor. */
export const BASE_SEPOLIA_DEPLOY_BLOCK = 45065094n;

/**
 * AgentPBMWalletFactory deploy block — the floor for enumerating `WalletCreated`.
 *
 * Taken from the deploy receipt of the 10 Aug 2026 redeploy — the exact block,
 * not an inference. (The previous factory's floor was binary-searched with
 * `eth_getCode`, because a floor derived from the oldest event a scan happened
 * to find is only as old as that observation, and one set too high loses wallets
 * silently rather than failing.) Starting from GantryCore's block instead would
 * scan ~229k blocks in which this contract did not exist, and every chunk is a
 * round trip.
 *
 * MOVE THIS WITH THE ADDRESS. A redeployed factory left on the old floor sends
 * every cold scan back over blocks that cannot hold one of its logs.
 */
export const BASE_SEPOLIA_FACTORY_DEPLOY_BLOCK = 45293974n;

export const BASE_SEPOLIA_RELAYER: Address = "0x82513007C7eB93b54dC555Bdb74341b3084FC47B";

export const BASESCAN_BASE_URL = "https://sepolia.basescan.org";

/**
 * Blocks per eth_getLogs window, expressed as a SPAN: a window runs
 * `from .. from + LOG_CHUNK_SPAN`, so it covers 2,000 blocks and fits the public
 * Base Sepolia node's documented 2,000-block ceiling exactly.
 *
 * One constant because one measured fact governs all three chunked walks (the
 * indexer sweep, the merchant registration-date walk, the agent factory scan),
 * and it used to be written out three times with three copies of the reasoning.
 * When the provider ceiling changes, three places had to change and the third
 * would have been found by a wedged cursor.
 *
 * Do not raise it: a larger range is refused outright and the sweep stops
 * advancing. Do not lower it to satisfy the paid provider either — Alchemy's free
 * tier caps this call at TEN blocks (measured 9 Aug 2026), so matching that would
 * turn a cold backfill into thousands of calls. Every window is therefore
 * rejected by the primary and served by the rate-limited public node, which is
 * why the correctness path leans on the free endpoint.
 */
export const LOG_CHUNK_SPAN = 1_999n;
