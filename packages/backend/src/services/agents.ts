import { erc20Abi, type Address } from "viem";
import {
  BASE_SEPOLIA_FACTORY_DEPLOY_BLOCK,
  agentPbmWalletAbi,
  agentPbmWalletFactoryAbi,
  tokenAddress,
  type AgentListResponse,
  type AgentSummary,
  type TokenId,
} from "@gantry/shared";
import { publicClient } from "../chain";
import { config } from "../config";
import { ApiError } from "../errors";
import { sameAddress, toAgentSummary, type RawAgentState } from "./agents-core";
import { readRate } from "./intents";

/**
 * Payer-owned agent wallets, read straight off the chain.
 *
 * There is no server-side registry of agents and there must not be one: the
 * factory is permissionless and every wallet is owned by the payer, so the only
 * honest answer to "which agents are mine" is the one the chain gives. Nothing
 * here is stored — every field of an AgentSummary is a live read.
 *
 * Read-only by design. `setPolicy` and `revoke` are `onlyOwner` and the owner is
 * now the payer, so those transactions are signed in the payer's browser; no
 * server key can write a policy any more.
 */

/** Every wallet is funded in the token every door settles in. */
const SPEND_TOKEN: TokenId = "USDC";

// ---------------------------------------------------------------- enumeration

interface CreatedWallet {
  wallet: Address;
  /** Owner AT CREATION. Ownership is transferable, so this is a candidate, not
   * an answer — the live `owner()` read below decides. */
  owner: Address;
  /** Likewise: `setAgentSigner` can rotate the key after creation. */
  agentSigner: Address;
}

/** Must fit EVERY transport in the fallback chain, and that is not only the
 * public node's documented 2,000-block cap: the configured Alchemy endpoint
 * refuses 9,999 too (measured — it answers -32602, and viem then fails over to
 * the public node, which answers the same). Same constant and same reason as
 * the indexer's sweep. */
const SCAN_CHUNK = 1_999n;
/**
 * Chunks in flight at once. The first scan spans every block since the deploy
 * (78 chunks today, growing ~22 a day), so serialised it is a page load measured
 * in tens of seconds.
 *
 * Four, not more: measured against the real endpoints, 4 finishes the backfill
 * in ~5.8s with no failures and 2 takes ~11s, while 6 exhausts Alchemy's
 * per-second allowance — and the failover from that lands on the public node,
 * which is rate-limited harder. Faster here means slower.
 */
const SCAN_CONCURRENCY = 4;
/** How far behind the cursor each pass re-reads. The cache only ever moves
 * forward, so without this a wallet created in a block that later reorganised
 * out and back in would be missing from it permanently. */
const REORG_SLACK = 64n;

/** Lowercased wallet address → creation record. WalletCreated logs are
 * append-only history, which is what makes them safe to remember: the scan is
 * paid once per process instead of once per page load. */
const known = new Map<string, CreatedWallet>();
let scannedTo: bigint | null = null;
let scanning: Promise<CreatedWallet[]> | null = null;

async function scanFactory(): Promise<CreatedWallet[]> {
  const head = await publicClient.getBlockNumber();
  // The FACTORY's deploy block, not the core's. `WalletCreated` cannot predate
  // the contract that emits it, and the two are ~68k blocks apart — starting
  // from the core would scan ~34 extra chunks per cold process, each of which
  // costs two RPC calls because the primary provider rejects the range (see
  // SWEEP_CHUNK in indexer.ts). The floor was verified by binary-searching
  // eth_getCode, not taken from the oldest event a scan happened to find.
  const from =
    scannedTo === null
      ? BASE_SEPOLIA_FACTORY_DEPLOY_BLOCK
      : scannedTo > REORG_SLACK
        ? scannedTo - REORG_SLACK
        : 0n;

  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  for (let start = from; start <= head; start += SCAN_CHUNK + 1n) {
    ranges.push({ fromBlock: start, toBlock: start + SCAN_CHUNK > head ? head : start + SCAN_CHUNK });
  }

  for (let i = 0; i < ranges.length; i += SCAN_CONCURRENCY) {
    const batches = await Promise.all(
      ranges.slice(i, i + SCAN_CONCURRENCY).map(({ fromBlock, toBlock }) =>
        publicClient.getContractEvents({
          address: config.addresses.agentPbmFactory,
          abi: agentPbmWalletFactoryAbi,
          eventName: "WalletCreated",
          fromBlock,
          toBlock,
        }),
      ),
    );
    for (const logs of batches) {
      for (const { args } of logs) {
        if (!args.owner || !args.agentSigner || !args.wallet) continue;
        known.set(args.wallet.toLowerCase(), {
          wallet: args.wallet,
          owner: args.owner,
          agentSigner: args.agentSigner,
        });
      }
    }
  }

  // Only after every chunk landed. A cursor advanced past a failed chunk would
  // hide the wallets in it for the life of the process.
  scannedTo = head;
  return [...known.values()];
}

/** One scan at a time: the agents screen is a page load, and two concurrent
 * requests on a cold process would otherwise each pay the full backfill. */
function factoryWallets(): Promise<CreatedWallet[]> {
  if (!scanning) scanning = scanFactory().finally(() => (scanning = null));
  return scanning;
}

// ---------------------------------------------------------------- chain reads

/** A multicall entry, narrow enough to read without re-stating viem's generics. */
type BatchResult = { status: "success" | "failure"; result?: unknown };

interface AgentReads {
  agents: AgentSummary[];
  /** Candidates that did not answer as an AgentPBMWallet. Not an RPC failure —
   * the aggregate call succeeded and these addresses did not respond to it. */
  unreadable: Address[];
}

/**
 * One AgentSummary per wallet in a fixed number of round trips.
 *
 * Five multicalls fired together, not five reads per wallet: an owner with three
 * agents costs exactly what an owner with one costs. Each batch is homogeneous
 * so the calldata stays trivial to read in a trace.
 *
 * `allowFailure` keeps two different failures apart — the same distinction
 * verifyPbm draws. A transport error rejects, and the caller gets a 5xx it can
 * retry. A per-entry failure means that address is not an AgentPBMWallet, which
 * is a fact about the address, and never something to render as zeros.
 */
async function readAgents(wallets: readonly Address[]): Promise<AgentReads> {
  if (wallets.length === 0) return { agents: [], unreadable: [] };
  const token = tokenAddress(config.addresses, SPEND_TOKEN);

  const [rate, owners, signers, policies, spent, balances] = await Promise.all([
    readRate(SPEND_TOKEN),
    publicClient.multicall({
      allowFailure: true,
      contracts: wallets.map(
        (address) => ({ address, abi: agentPbmWalletAbi, functionName: "owner" }) as const,
      ),
    }),
    publicClient.multicall({
      allowFailure: true,
      contracts: wallets.map(
        (address) => ({ address, abi: agentPbmWalletAbi, functionName: "agentSigner" }) as const,
      ),
    }),
    publicClient.multicall({
      allowFailure: true,
      contracts: wallets.map(
        (address) => ({ address, abi: agentPbmWalletAbi, functionName: "policy" }) as const,
      ),
    }),
    publicClient.multicall({
      allowFailure: true,
      contracts: wallets.map(
        (address) => ({ address, abi: agentPbmWalletAbi, functionName: "spentToday" }) as const,
      ),
    }),
    publicClient.multicall({
      allowFailure: true,
      contracts: wallets.map(
        (wallet) => ({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }) as const,
      ),
    }),
  ]);

  const agents: AgentSummary[] = [];
  const unreadable: Address[] = [];
  const batches: readonly BatchResult[][] = [owners, signers, policies, spent, balances];
  wallets.forEach((wallet, i) => {
    if (batches.some((batch) => batch[i]?.status !== "success")) {
      unreadable.push(wallet);
      return;
    }
    const raw: RawAgentState = {
      wallet,
      owner: owners[i]!.result as Address,
      agentSigner: signers[i]!.result as Address,
      policy: policies[i]!.result as readonly [bigint, bigint, number, bigint],
      spentToday: spent[i]!.result as bigint,
      balance: balances[i]!.result as bigint,
      token: SPEND_TOKEN,
      rate,
    };
    agents.push(toAgentSummary(raw));
  });
  return { agents, unreadable };
}

// ---------------------------------------------------------------- public API

export interface AgentFilter {
  owner?: Address;
  /** The agent's session key. Indexed on WalletCreated exactly like `owner`, so
   * an agent that knows only its own key can find the wallets it acts for —
   * which is what lets the CLI stop carrying a hardcoded wallet address. */
  agentSigner?: Address;
}

/**
 * Wallets matching the filter. At least one field must be set; setting both
 * narrows.
 *
 * The creation logs give candidates and the live reads decide: ownership is
 * `Ownable2Step` and the signer rotates through `setAgentSigner`, so a log is a
 * record of who created a wallet, not of who controls it now. Listing a wallet
 * the caller can no longer act on would be a screen of buttons that revert.
 *
 * The blind spot that leaves is the mirror image, and it is inherent to log
 * enumeration: a wallet transferred or re-signed TO you was created naming
 * somebody else, so it is never a candidate. Nothing on the chain indexes the
 * current owner.
 */
export async function listAgents(filter: AgentFilter): Promise<AgentListResponse> {
  const created = await factoryWallets();
  const candidates = created
    .filter((c) => !filter.owner || sameAddress(c.owner, filter.owner))
    .filter((c) => !filter.agentSigner || sameAddress(c.agentSigner, filter.agentSigner))
    .map((c) => c.wallet);

  const { agents, unreadable } = await readAgents(candidates);
  if (unreadable.length > 0) {
    // Dropped rather than failed: the rest of the list is real, and an address
    // that stopped answering is one the caller could not act on anyway.
    console.warn(`agents: ${unreadable.join(", ")} did not answer as AgentPBMWallet — omitted`);
  }
  return {
    agents: agents.filter(
      (a) =>
        (!filter.owner || sameAddress(a.owner, filter.owner)) &&
        (!filter.agentSigner || sameAddress(a.agentSigner, filter.agentSigner)),
    ),
  };
}

/**
 * One wallet by address, with no ownership check — deliberately. Reading a
 * policy is reading the chain, and the chain is public; the wallet's protection
 * is that only its owner can WRITE to it. This is also what lets the agent CLI
 * and the merchant-side tooling read a wallet they do not own.
 */
export async function getAgent(wallet: Address): Promise<AgentSummary> {
  const { agents, unreadable } = await readAgents([wallet]);
  const agent = agents[0];
  if (!agent) {
    throw new ApiError(
      404,
      "UnknownAgentWallet",
      unreadable.length > 0
        ? `no AgentPBMWallet at ${wallet} — it did not answer owner()/policy()`
        : `no AgentPBMWallet at ${wallet}`,
    );
  }
  return agent;
}
