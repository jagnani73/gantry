import { erc20Abi, type Address } from "viem";
import {
  agentPbmWalletAbi,
  agentPbmWalletFactoryAbi,
  checksummed,
  tokenAddress,
  type AgentListResponse,
  type AgentSummary,
  type TokenId,
} from "@gantry/shared";
import { publicClient } from "../chain";
import { config } from "../config";
import { ApiError } from "../errors";
import { agentWalletsBySigner } from "../db";
import { sweepNow } from "../indexer";
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
//
// Two lookups, because the two questions have different cheapest answers.
//
// BY OWNER — `walletsOf` is a view on the factory, so this is ONE eth_call and it
// is always current: a wallet the payer created a second ago is in it before any
// indexer has seen the block. That matters, because the payer app calls this
// immediately after creating one.
//
// BY SIGNER — the factory indexes only by owner, so this reads the wallets the
// indexer swept into `agent_wallets` from `WalletCreated`. It replaced a chunked
// scanner that re-walked the whole block range on every cold process, grew ~22
// windows a day, and died on Render's shared egress IP; folding those logs into
// the sweep the indexer already runs made all of that machinery redundant.
//
// Both return CANDIDATES. Ownership is `Ownable2Step` and the signer rotates, so
// neither source knows who controls a wallet now — the live reads below decide.

async function walletsOwnedBy(owner: Address): Promise<Address[]> {
  return (await publicClient.readContract({
    address: config.addresses.agentPbmFactory,
    abi: agentPbmWalletFactoryAbi,
    functionName: "walletsOf",
    args: [owner],
  })) as Address[];
}

/**
 * Candidate wallets for a filter, before any of them are read.
 *
 * A signer filter can be answered only from the swept table, which lags the chain
 * by up to one sweep. `sweepNow` closes that: the CLI creating a wallet and
 * immediately asking which wallets it acts for is the normal case, not an edge
 * one, and a sweep from a cursor seconds old costs a single getLogs window.
 */
async function candidates(filter: AgentFilter): Promise<Address[]> {
  // OWNER FIRST whenever we have it, even alongside a signer filter. `walletsOf`
  // is a view: one eth_call, and never behind — a wallet created a second ago is
  // in it before any sweep has seen the block. The signer narrowing costs
  // nothing here because `listAgents` re-filters on the LIVE `agentSigner()`
  // reads anyway. Taking the swept table for `?owner=&agentSigner=` — which is
  // exactly what demo-reset asks — would answer a fresh wallet with "none", and
  // that answer is what makes a caller mint a second wallet for one signer.
  if (filter.owner) return walletsOwnedBy(filter.owner);

  if (filter.agentSigner) {
    let rows = agentWalletsBySigner(filter.agentSigner, config.addresses.agentPbmFactory);
    if (rows.length === 0) {
      // Nothing known for this signer, and the factory indexes only by owner, so
      // there is no view to fall back on. Make the index current before
      // answering — and find out whether it actually became current.
      const current = await sweepNow();
      rows = agentWalletsBySigner(filter.agentSigner, config.addresses.agentPbmFactory);
      if (rows.length === 0 && !current) {
        // NOT an empty list. The sweep failed or ran out of time, so this is a
        // non-answer, and rendering it as "you own no wallets" is the outcome
        // that makes an agent CLI deploy a duplicate. The deleted scanner
        // carried a 503 for exactly this and it had to come with it.
        throw new ApiError(
          503,
          "AgentIndexUnavailable",
          "the wallet index could not be brought up to date, so this is not an answer about " +
            "your agents. Do not create a wallet on the strength of it — retry in a moment.",
        );
      }
    }
    // Re-checksummed, because the swept table stores addresses lowercased and
    // the owner branch above returns whatever `walletsOf` gives — i.e. EIP-55.
    // One field must not arrive in two casings depending on which filter asked
    // for it: this address is printed on stage by the agent CLI and used as an
    // EIP-712 `verifyingContract`.
    return rows.map((row) => checksummed(row.wallet));
  }
  return [];
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

  const [rate, owners, signers, policies, spent, balances, stamps, labels] = await Promise.all([
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
    // These two are DISPLAY reads, and the `.catch` is what keeps them that way.
    // Everything above shares one `Promise.all`, so a transport-level rejection
    // — a 429 from the rate-limited public node, a timeout — rejects the whole
    // read and turns into a 503 over the entire agents surface. Two fields the
    // code declares non-essential must not hold that veto, and adding them took
    // the round trips that can trigger it from six to eight. An empty array
    // reads back as "not successful" through the optional chaining below, which
    // is the same degradation a per-entry failure already gets.
    publicClient
      .multicall({
        allowFailure: true,
        contracts: wallets.map(
          (address) => ({ address, abi: agentPbmWalletAbi, functionName: "policyUpdatedAt" }) as const,
        ),
      })
      .catch((err: unknown) => {
        console.warn("agents: policyUpdatedAt batch failed, dates degraded to 0", err);
        return [] as BatchResult[];
      }),
    publicClient
      .multicall({
        allowFailure: true,
        contracts: wallets.map(
          (address) => ({ address, abi: agentPbmWalletAbi, functionName: "label" }) as const,
        ),
      })
      .catch((err: unknown) => {
        console.warn("agents: label batch failed, names degraded to empty", err);
        return [] as BatchResult[];
      }),
  ]);

  const agents: AgentSummary[] = [];
  const failed: Address[] = [];
  // `stamps` and `labels` are deliberately NOT in this list. Both getters arrived
  // with the 10 Aug 2026 factory, so a wallet from the previous one answers
  // everything that matters and reverts on exactly these two — and calling that
  // wallet "holds code but did not answer" would hide a policy its owner may
  // still want to read or revoke. They degrade to 0 and "" instead, which is
  // what an unnamed, never-armed wallet reports anyway.
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
      // `uint40`, so viem hands back a number rather than a bigint.
      policyUpdatedAt: stamps[i]?.status === "success" ? (stamps[i]!.result as number) : 0,
      label: labels[i]?.status === "success" ? (labels[i]!.result as string) : "",
    };
    // Both degraded values COLLIDE with real ones — "" is a legitimately unnamed
    // wallet and 0 a legitimately unarmed one — so the substitution is invisible
    // in the response and has to be visible in the log. A degraded label is the
    // costly one: the web's freshness fingerprint includes it, so a wallet whose
    // name failed to read can never match the expectation and every write against
    // it stalls for the full poll before giving up.
    if (stamps[i]?.status !== "success" || labels[i]?.status !== "success") {
      console.warn(
        `agents: ${wallet} did not answer ${stamps[i]?.status !== "success" ? "policyUpdatedAt " : ""}` +
          `${labels[i]?.status !== "success" ? "label" : ""}`.trim() +
          " — degraded to 0/empty (expected only for a pre-10-Aug-2026 wallet)",
      );
    }
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
        (err: unknown) => {
          // Logged, not dropped. Both outcomes end up reported as "holds code but
          // did not read", and an operator otherwise cannot tell a failed
          // multicall entry from a failed getCode — different providers, different
          // fixes. This was the one bare swallow in a file built around the
          // failed-vs-unknown distinction.
          console.warn(`agents: getCode failed for ${address}, classified unreadable`, err);
          return { read: false, code: undefined };
        },
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
  const { agents, absent, unreadable } = await readAgents(await candidates(filter));
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
