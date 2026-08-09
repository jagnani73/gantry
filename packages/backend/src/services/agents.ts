import { erc20Abi, type Address } from "viem";
import {
  BASE_SEPOLIA_FACTORY_DEPLOY_BLOCK,
  LOG_CHUNK_SPAN,
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
import {
  advanceCursor,
  completeThrough,
  foldWalletCreated,
  runScan,
  sameAddress,
  tileRanges,
  toAgentSummary,
  type CreatedWallet,
  type RawAgentState,
} from "./agents-core";
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

/** Must fit EVERY transport in the fallback chain. Not merely the public node's
 * 2,000-block cap: the configured Alchemy endpoint refuses these ranges too (its
 * free tier caps eth_getLogs at TEN blocks), so every window is rejected by the
 * primary and served by the public node — two RPC calls per window, with the
 * rate-limited node carrying the work. Same constant and same measurement as the
 * indexer's sweep. */
const SCAN_CHUNK = LOG_CHUNK_SPAN;
/**
 * Windows in flight on the first pass. The scan spans every block since the
 * factory deploy (54 windows on 9 Aug 2026, growing ~22 a day), so serialised it
 * is a page load measured in tens of seconds.
 *
 * Four was measured from a laptop against the real fallback chain: 4 finishes in
 * ~5.8s with no failures and 2 takes ~11s. That measurement does NOT transfer to
 * the deployed host, and the reason is the useful part: the rate limit belongs to
 * the EGRESS IP, not to the endpoint. Re-measured 9 Aug 2026 — this same 54-window
 * scan ran against sepolia.base.org from a laptop with zero failures, and died on
 * Render after ~48 windows in 1.8s with "over rate limit" from that same endpoint.
 * So this number is a throughput choice and never the safety mechanism; the retry
 * passes and the deadline are.
 */
const SCAN_CONCURRENCY = 4;
/** Fewer in flight while a throttled bucket is refilling. */
const RETRY_CONCURRENCY = 2;
/**
 * Delay BEFORE each retry pass — three delays, four passes, since nothing
 * precedes pass 0.
 *
 * Not a second copy of viem's retry. viem already retries a 429 three times
 * (`fallback` pins its children to retryCount 0 and retries the chain itself),
 * and it loses anyway: its backoff is 150/300/600ms and it runs while the rest of
 * the batch keeps firing, which is exactly when a token bucket cannot refill.
 * These waits are 5x longer and the whole scan is idle through them, which is the
 * condition the node is actually waiting for. Retrying only the failed windows is
 * what keeps that affordable.
 */
const RETRY_BACKOFF_MS = [750, 1_500, 3_000];
/**
 * Wall-clock budget for one scan, deliberately under the payer app's 20s abort
 * (`web/src/lib/api.ts`). Past that the browser has already given up, so every
 * further request buys nothing and deepens the throttle it is trying to escape.
 *
 * A floor under the damage, not a fix. A clean pass 0 is ~5.8s at 54 windows
 * today and grows ~22 windows a day, so it crosses this budget well before the
 * finals — the real fix is folding WalletCreated into the indexer's persisted
 * sweep so a page load does no getLogs at all.
 */
const SCAN_DEADLINE_MS = 15_000;
/** How far behind the cursor each pass re-reads. The cache only ever moves
 * forward, so without this a wallet created in a block that later reorganised
 * out and back in would be missing from it permanently. */
const REORG_SLACK = 64n;

/** Lowercased wallet address to creation record. WalletCreated logs are
 * append-only history, which is what makes them safe to remember: the scan is
 * paid once per process instead of once per page load. */
const known = new Map<string, CreatedWallet>();
/**
 * Highest block through which `known` is COMPLETE, INCLUSIVE — never merely the
 * highest block some window reached. A partial scan advances it to the last block
 * before the lowest window that failed; a full scan advances it to the head that
 * scan read. Anything looser hides the wallets in a skipped window for the life
 * of the process.
 */
let scannedTo: bigint | null = null;
let scanning: Promise<CreatedWallet[]> | null = null;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function scanFactory(): Promise<CreatedWallet[]> {
  const head = await publicClient.getBlockNumber();
  // The FACTORY's deploy block, not the core's. `WalletCreated` cannot predate
  // the contract that emits it, and the two are ~68k blocks apart — starting from
  // the core would scan ~34 extra windows per cold process, each costing two RPC
  // calls. The floor was verified by binary-searching eth_getCode, not taken from
  // the oldest event a scan happened to find.
  const from =
    scannedTo === null
      ? BASE_SEPOLIA_FACTORY_DEPLOY_BLOCK
      : scannedTo > REORG_SLACK
        ? scannedTo - REORG_SLACK
        : 0n;

  const ranges = tileRanges(from, head, SCAN_CHUNK);
  const outcome = await runScan(
    ranges,
    {
      fetchRange: ({ fromBlock, toBlock }) =>
        publicClient.getContractEvents({
          address: config.addresses.agentPbmFactory,
          abi: agentPbmWalletFactoryAbi,
          eventName: "WalletCreated",
          fromBlock,
          toBlock,
        }),
      fold: (logs) => foldWalletCreated(logs, known),
      sleep,
      now: () => Date.now(),
      warn: (message) => console.warn(`agents: ${message}`),
    },
    {
      concurrency: SCAN_CONCURRENCY,
      retryConcurrency: RETRY_CONCURRENCY,
      backoffsMs: RETRY_BACKOFF_MS,
      deadlineMs: SCAN_DEADLINE_MS,
    },
  );

  // Keep the ground that WAS covered, so the next attempt finishes the tail
  // instead of paying for the whole span again. Without this a throttled scan is
  // self-sustaining: it discards every window that succeeded, and the payer's
  // natural retry re-fires all of them into a bucket that is still empty — which
  // is how a page that should merely be slow becomes permanently broken. This
  // helps a TAIL failure most: a failure early in the span still parks the cursor
  // near the start, and the next call re-reads windows already folded in.
  scannedTo = advanceCursor(scannedTo, completeThrough(outcome.pending, from, head));

  if (outcome.pending.length > 0) {
    const unread = outcome.pending.length;
    // The viem error goes to the operator and never to the payer. It carries the
    // full RPC URL, and an Alchemy key lives in that URL's PATH — which viem's
    // own redaction does not strip, because it only removes user:password.
    // `errorMiddleware` echoes `err.message` into the response body, so throwing
    // this raw would publish the key on a public route the moment the key-bearing
    // transport is the last one to fail.
    console.error(
      `agents: factory scan incomplete (${outcome.stoppedBy}) — ${unread}/${ranges.length} windows unread in ${from}..${head}, cursor now ${scannedTo ?? "unset"}:`,
      outcome.error,
    );
    // 503, matching `getAgent` below: the read failed, the wallets are not
    // missing, and retry is the true advice. A 500 invites the payer to believe
    // an empty list, and their next move on one is a duplicate wallet.
    throw new ApiError(
      503,
      "AgentScanFailed",
      `could not read ${unread} of ${ranges.length} block ranges from the chain, so this list would be incomplete. Retry in a moment.`,
    );
  }
  return [...known.values()];
}

/** One scan at a time: the agents screen is a page load, and two concurrent
 * requests on a cold process would otherwise each pay the full backfill.
 *
 * Safe with a partial scan because `scanFactory` writes the cursor BEFORE it
 * throws, and `.finally` clears this only once the promise has settled — so the
 * next caller always reads a written cursor and resumes rather than restarting. */
function factoryWallets(): Promise<CreatedWallet[]> {
  if (!scanning) scanning = scanFactory().finally(() => (scanning = null));
  return scanning;
}

// ---------------------------------------------------------------- chain reads

/** A multicall entry, narrow enough to read without re-stating viem's generics. */
type BatchResult = { status: "success" | "failure"; result?: unknown };

interface AgentReads {
  agents: AgentSummary[];
  /** Candidates that hold no code at all, so there is nothing there to read.
   * The only honest "you do not have this agent". */
  absent: Address[];
  /**
   * Candidates that DO hold code and still did not answer. A failed read, never
   * a fact about the wallet — and the distinction is the whole point: a lagging
   * replica and an out-of-gas aggregate produce exactly the same per-entry
   * failure as a non-wallet, and rendering that as "you have no agent" is how a
   * payer creates a SECOND wallet for the same signer (the state demo-reset
   * step 6b exists to detect).
   */
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
 * retry. A per-entry failure is NOT self-describing, so each one costs a single
 * extra `getCode` to say which of the two it was.
 */
async function readAgents(wallets: readonly Address[]): Promise<AgentReads> {
  if (wallets.length === 0) return { agents: [], absent: [], unreadable: [] };
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
  const failed: Address[] = [];
  const batches: readonly BatchResult[][] = [owners, signers, policies, spent, balances];
  wallets.forEach((wallet, i) => {
    if (batches.some((batch) => batch[i]?.status !== "success")) {
      failed.push(wallet);
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
  return { agents, ...(await classifyFailures(failed)) };
}

/**
 * Which of the failed candidates are not contracts, and which are contracts we
 * could not read.
 *
 * `getCode` is the only question that separates them, and it is cheap because it
 * is asked ONLY about entries that already failed — the happy path pays nothing.
 * A `getCode` that itself fails counts as unreadable: it proves nothing, and the
 * conservative answer is the one that does not tell a payer their agent is gone.
 *
 * In practice `absent` should stay empty for wallets that came out of the
 * factory's own `WalletCreated` logs — the factory deployed every one of them —
 * which is exactly why a failed read must not be treated as "not a wallet". It
 * is reachable for an address handed to `getAgent` directly, and for a log from
 * a block that reorganised out.
 */
async function classifyFailures(
  wallets: readonly Address[],
): Promise<{ absent: Address[]; unreadable: Address[] }> {
  const absent: Address[] = [];
  const unreadable: Address[] = [];
  if (wallets.length === 0) return { absent, unreadable };

  const codes = await Promise.all(
    wallets.map((address) =>
      publicClient.getCode({ address }).then(
        (code) => ({ read: true, code }),
        () => ({ read: false, code: undefined }),
      ),
    ),
  );
  wallets.forEach((wallet, i) => {
    const entry = codes[i];
    if (entry?.read && (entry.code === undefined || entry.code === "0x")) absent.push(wallet);
    else unreadable.push(wallet);
  });
  return { absent, unreadable };
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
 * The list plus the candidates it could not speak for. Structurally an
 * `AgentListResponse` with one added optional field, so every existing client
 * keeps reading `agents` and nothing else changes shape.
 */
export interface AgentListBody extends AgentListResponse {
  /**
   * Wallets this caller owns (or signs for) whose on-chain state did not read.
   * Present only when non-empty, and never merged into `agents` — there is
   * nothing truthful to render for them.
   *
   * A screen MUST announce these. "You have no agent" and "one of your agents
   * could not be read" lead to opposite actions, and the first one leads to
   * creating a duplicate wallet for the same signer.
   */
  unreadable?: Address[];
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
export async function listAgents(filter: AgentFilter): Promise<AgentListBody> {
  const created = await factoryWallets();
  const candidates = created
    .filter((c) => !filter.owner || sameAddress(c.owner, filter.owner))
    .filter((c) => !filter.agentSigner || sameAddress(c.agentSigner, filter.agentSigner))
    .map((c) => c.wallet);

  const { agents, absent, unreadable } = await readAgents(candidates);
  if (absent.length > 0) {
    // Nothing is deployed there, so there is nothing to report and no action to
    // offer. Logged because a factory candidate with no code means a reorg.
    console.warn(`agents: ${absent.join(", ")} holds no code — dropped from the list`);
  }
  if (unreadable.length > 0) {
    // NOT dropped silently. These are already scoped to this caller by the
    // creation-log filter, so returning them is not leaking somebody else's
    // wallet — it is the difference between a short list and a wrong one.
    console.warn(`agents: ${unreadable.join(", ")} holds code but did not read — reported unreadable`);
  }
  return {
    agents: agents.filter(
      (a) =>
        (!filter.owner || sameAddress(a.owner, filter.owner)) &&
        (!filter.agentSigner || sameAddress(a.agentSigner, filter.agentSigner)),
    ),
    ...(unreadable.length > 0 ? { unreadable } : {}),
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
  if (agent) return agent;
  if (unreadable.length > 0) {
    // A contract IS deployed here and the reads failed anyway, so 404 would be a
    // claim we cannot make — and the caller's next move on a 404 is to create a
    // wallet they may already own. 503 says retry, which is the true advice.
    throw new ApiError(
      503,
      "AgentReadFailed",
      `${wallet} holds code but did not answer owner()/policy(). The read failed, ` +
        "the wallet is not missing. Retry in a moment.",
    );
  }
  throw new ApiError(404, "UnknownAgentWallet", `no AgentPBMWallet at ${wallet}`);
}
