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
 * Deployed together by `pnpm contracts:fresh`, 11 Aug 2026. Basescan-verified.
 *
 * TOGETHER is the invariant. `AgentPBMWallet.CORE` is immutable and the factory
 * pins the core it was constructed with, so a core deployed without its factory
 * is a pair that can never be made coherent again — and one deploy block only
 * means anything if nothing here predates it. Change any contract and they all
 * ship again; there is no partial redeploy of this table.
 *
 * `realUsdc` is the exception and is not ours: Circle's testnet USDC, fixed.
 *
 * No wallet address belongs here. Agent wallets are minted per payer by the
 * permissionless factory, so any one of them is a sample rather than a constant
 * — `pnpm demo:reset` provisions the rehearsal one.
 */
export const BASE_SEPOLIA_ADDRESSES: GantryAddresses = {
  gantryCore: "0xE6289ceA9232af61d7e4F30A67a848c0C322cc93",
  fixedRateSwap: "0xd84F8C46E7CAEA01188B6e27E8f1a07aD8311a0d",
  mockXsgd: "0xffebE1735e22c274Ae30B2fBb3d4e422a75e3503",
  realUsdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  agentPbmFactory: "0x9e51484b1B79bB3E9EaCEfB3D3510Cc19b7Baac1",
};

/**
 * THE deploy block. Singular, and that is the point.
 *
 * Every contract above ships in one `pnpm contracts:fresh` run, so one floor
 * serves the indexer's sweep and the agent-wallet lookup alike. There used to be
 * two — GantryCore's and the factory's, ~229k blocks apart because they were
 * deployed months apart in project time — and the gap is what forced a second
 * chunked scanner over a range the indexer already walked. Collapsing them is
 * what let `WalletCreated` fold into the same `getLogs` pass.
 *
 * Taken from the deploy receipt, never inferred. It may UNDER-state (the script
 * reads `block.number` before broadcasting), which costs a few empty windows;
 * over-stating would silently lose logs, and a scan floor must never do that.
 *
 * MOVE IT WITH THE ADDRESSES. A redeploy left on an old floor sends every cold
 * backfill over blocks that cannot hold one of these contracts' logs.
 */
export const BASE_SEPOLIA_DEPLOY_BLOCK = 45328301n;

/**
 * Factories this project has retired, oldest first.
 *
 * Kept because `walletsOf` only answers for the factory you ask, so a wallet
 * minted by a superseded one is reachable by address and by nothing else — and
 * they hold real USDC. `pnpm contracts:fresh` sweeps every entry here as well as
 * the live factory, and appends the outgoing address when it repoints the table,
 * so the list maintains itself rather than depending on someone remembering.
 *
 * Nothing in the running app reads this: enumeration is scoped to the CURRENT
 * factory on purpose, because a wallet from a retired one is pinned to a retired
 * core and reverts on every payment. This is a recovery list, not a registry.
 */
export const BASE_SEPOLIA_RETIRED_FACTORIES: readonly Address[] = [
  "0x0cbDFEfF733289f790a930112Cc653c602cf52d3", // retired 2026-08-11
  "0x7E864606d6c86Fa1d7d6B1c7faE8CE555164a21a", // retired 2026-08-11
  "0x172905F26F09b41636854338360315971240c1cf", // M3, 7 Aug 2026
  "0xd827C3445660a4D2d68c5D411DAbAE71B7fdcA05", // 10 Aug 2026, on-chain label + policyUpdatedAt
];

export const BASE_SEPOLIA_RELAYER: Address = "0x82513007C7eB93b54dC555Bdb74341b3084FC47B";

export const BASESCAN_BASE_URL = "https://sepolia.basescan.org";

/**
 * Blocks per eth_getLogs window, expressed as a SPAN: a window runs
 * `from .. from + LOG_CHUNK_SPAN`, so it covers 2,000 blocks and fits the public
 * Base Sepolia node's documented 2,000-block ceiling exactly.
 *
 * One constant because one measured fact governs both remaining chunked walks
 * (the indexer sweep and the merchant registration-date walk), and it used to be
 * written out once per walk with a copy of the reasoning each time. A third
 * consumer, the agent factory scan, was deleted outright when `WalletCreated`
 * folded into the sweep.
 *
 * Do not raise it: a larger range is refused outright and the sweep stops
 * advancing. Do not lower it to satisfy the paid provider either — Alchemy's free
 * tier caps this call at TEN blocks (measured 9 Aug 2026), so matching that would
 * turn a cold backfill into thousands of calls. Every window is therefore
 * rejected by the primary and served by the rate-limited public node, which is
 * why the correctness path leans on the free endpoint.
 */
export const LOG_CHUNK_SPAN = 1_999n;
