import { erc20Abi, type Address } from "viem";
import {
  agentPbmWalletAbi,
  agentPbmWalletFactoryAbi,
  checksummed,
  PAYABLE_TOKEN_IDS,
  resolveAgentCurrency,
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

/*
 * AN AGENT'S CURRENCY IS DERIVED FROM WHAT IT HOLDS, never stored — see
 * `resolveAgentCurrency` in shared for why it cannot be.
 *
 * This file used to hold one constant, `SPEND_TOKEN = "USDC"`, and every
 * agent's balance, rate and S$ cap conversion read off it. The moment EURC
 * became payable that constant would have relabelled a euro wallet's caps in
 * dollars, so the reads are per-token now and each wallet reports its own.
 *
 * ONE currency per agent, and the constraint is the contract's: `dailyCap`,
 * `perTxCap` and `_spentToday` are single values in one token's units, so a
 * wallet spending two of them counts €1 as $1. The default for an unfunded
 * wallet lives in the resolver rather than here, so display and enforcement
 * cannot disagree about it.
 */

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
 * Did the CURRENT factory mint this address?
 *
 * `pbmWallet` arrives in a client payload, and reading `CORE()` off it is not an
 * answer: that is a getter, and a contract an attacker wrote returns whatever it
 * likes from a getter. Without provenance the relayer calls `authorizeSpend` on
 * attacker code, and the revert it chooses is then decoded and carried into
 * `cancelIntentWithReason` — so an attacker authors an attributed `IntentDenied`
 * that every host's indexer replicates as a real refusal.
 *
 * `_walletsOf` is the factory's own record, written inside `createWallet`, so it
 * cannot be forged and it is current the instant a wallet exists — no sweep to
 * wait for. Reading `owner()` off the wallet first is safe for the same reason
 * the check works at all: a hostile contract may claim any owner, but the
 * factory's list for that owner will not contain an address the factory never
 * deployed.
 *
 * Fails CLOSED. An unreadable `owner()` is exactly what a non-wallet looks like,
 * and an RPC failure is not permission to attribute a refusal to someone.
 */
export async function isFactoryWallet(wallet: Address): Promise<boolean> {
  try {
    const owner = (await publicClient.readContract({
      address: wallet,
      abi: agentPbmWalletAbi,
      functionName: "owner",
    })) as Address;
    return (await walletsOwnedBy(owner)).some((minted) => sameAddress(minted, wallet));
  } catch {
    return false;
  }
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
 * Every per-wallet getter this read needs; the batch below is laid out in this
 * order, field-major.
 *
 * The order is an implementation detail and nothing may depend on it — the slices
 * are addressed by NAME (see `read` below), so this array can be reordered
 * freely. That was not true when the slices were destructured positionally
 * behind a tuple cast, and the cast suppressed the one error that would have
 * caught a reorder.
 *
 * Adding an entry fetches and slices it automatically; it is then ignored until
 * something reads it by name.
 */
const WALLET_READS = [
  "owner",
  "agentSigner",
  "policy",
  "spentToday",
  "policyUpdatedAt",
  "label",
] as const;

/**
 * One AgentSummary per wallet, in ONE round trip.
 *
 * Not one read per wallet, and — since 20 Aug — not one batch per field either.
 * This used to fire eight multicalls under a `Promise.all`: six wallet getters
 * plus a balance batch per payable token. Eight separate JSON-RPC requests over
 * a fallback transport chain, which means up to eight different nodes, at up to
 * eight different block heights, composed into one response that says nothing
 * about which. A payer hit exactly that: a rename confirmed in the browser came
 * back as the new policy beside the OLD name, because the policy batch had seen
 * the block and the label batch had not, and every screen downstream rendered
 * the mixture as one coherent fact.
 *
 * Collapsed into a single multicall, that is unrepresentable: one request, one
 * node, one block, atomic by construction. It is also strictly cheaper against
 * the rate-limited public node the sweep already leans on. `batchSize: 0` is
 * what makes it one request rather than several — viem otherwise splits on
 * calldata size and would quietly reintroduce the split it was collapsed to
 * avoid.
 *
 * The wallet set is always one owner's or one signer's — an unfiltered
 * enumeration is refused a layer up — but that is a SCOPE bound, not a size one,
 * and the difference matters here: `walletsOf` is an unbounded array,
 * `createWallet` has no idempotency, no wallet can ever be deleted, and a
 * deployed build shares one demo key across every visitor, so the list grows
 * monotonically. At 8 calls per wallet the ceiling is whatever the node accepts
 * in one `eth_call`, and passing it does not degrade gracefully: `allowFailure`
 * turns the rejected chunk into a failure for EVERY wallet at once. If that list
 * ever gets long the answer is paging the wallet set, not restoring the split.
 *
 * Pinning a `blockNumber` was the other candidate and is worse here: on a
 * fallback chain a block some replica has not seen turns a stale read into a
 * failed one, and these wallets would land in the "could not be read" notice —
 * a scarier wrong answer than a slightly old one.
 *
 * `allowFailure` keeps two different failures apart — the same distinction
 * verifyPbm draws. A transport error does NOT reject and does not
 * produce a 5xx, whatever this comment used to say: viem converts a rejected
 * aggregate into a `failure` entry for every call in the chunk when
 * `allowFailure` is set. So it marks every wallet failed, and each one costs a
 * single extra `getCode` to say whether it is `absent` (no code, an honest "not
 * an agent") or `unreadable` (holds code, did not answer). The route answers 200
 * with those lists, and the payer app's UnreadableNotice is what stands between
 * that and "you have no agents" — the answer that makes a caller mint a second
 * wallet for one signer.
 */
async function readAgents(wallets: readonly Address[]): Promise<AgentReads> {
  if (wallets.length === 0) return { agents: [], absent: [], unreadable: [] };

  // ONE batch: every getter for every wallet, then every payable token's
  // balance for every wallet. Laid out field-major so a slice per field falls
  // straight out of the result, in the order `WALLET_READS` declares.
  const contracts = [
    ...WALLET_READS.flatMap((functionName) =>
      wallets.map((address) => ({ address, abi: agentPbmWalletAbi, functionName }) as const),
    ),
    ...PAYABLE_TOKEN_IDS.flatMap((id) =>
      wallets.map(
        (wallet) =>
          ({
            address: tokenAddress(config.addresses, id),
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [wallet],
          }) as const,
      ),
    ),
  ];
  // The rate rides alongside rather than inside: it is a swap read, per TOKEN
  // rather than per wallet, and a display conversion rather than a fact the
  // policy depends on — so it has no stake in the single-block guarantee. Fired
  // concurrently, because serialising it would trade a round trip for nothing.
  const [results, rates] = (await Promise.all([
    publicClient.multicall({
      allowFailure: true,
      // See the note above: without this viem splits on calldata size and the
      // single-block guarantee this whole shape exists for is gone.
      batchSize: 0,
      contracts,
    }),
    Promise.all(PAYABLE_TOKEN_IDS.map((id) => readRate(id))),
  ])) as [BatchResult[], bigint[]];
  const rateOf = new Map(PAYABLE_TOKEN_IDS.map((id, i) => [id, rates[i]!]));
  // A short result would silently shift every slice onto the wrong field, which
  // is the one way this layout can lie. Cheaper to assert than to debug.
  if (results.length !== contracts.length) {
    throw new Error(
      `agents: multicall returned ${results.length} of ${contracts.length} results`,
    );
  }
  const fieldAt = (index: number): BatchResult[] =>
    results.slice(index * wallets.length, (index + 1) * wallets.length);
  /**
   * Slices addressed by NAME, not by position.
   *
   * This was a positional destructure behind a six-element tuple `as`, which was
   * two mistakes. The cast asserted an arity it never checked against
   * `WALLET_READS.length` — and it was a no-op besides, since destructuring
   * `BatchResult[][]` already yields `BatchResult[]` per name under this
   * tsconfig. What it did do was suppress the error that would have caught the
   * real hazard: REORDERING `WALLET_READS`. Move `label` above `owner` and
   * `owners[i].result as Address` receives a decoded label string, `listAgents`
   * filters on `sameAddress(a.owner, filter.owner)` and matches nothing, and the
   * route answers **200 with an empty agents array** — the exact answer that
   * makes a caller mint a second wallet for one signer.
   *
   * Keyed lookup makes the order of the array irrelevant, which is what the
   * "the array IS the layout" claim above was reaching for.
   */
  const offsets = new Map(WALLET_READS.map((name, i) => [name, i]));
  const read = (name: (typeof WALLET_READS)[number]): BatchResult[] => fieldAt(offsets.get(name)!);
  const owners = read("owner");
  const signers = read("agentSigner");
  const policies = read("policy");
  const spent = read("spentToday");
  const stamps = read("policyUpdatedAt");
  const labels = read("label");
  const balancesByToken = PAYABLE_TOKEN_IDS.map((_, i) => fieldAt(WALLET_READS.length + i));

  const agents: AgentSummary[] = [];
  const failed: Address[] = [];
  // `stamps` and `labels` are deliberately NOT in this list. Both getters arrived
  // with the 10 Aug 2026 factory, so a wallet from the previous one answers
  // everything that matters and reverts on exactly these two — and calling that
  // wallet "holds code but did not answer" would hide a policy its owner may
  // still want to read or revoke. They degrade to 0 and "" instead, which is
  // what an unnamed, never-armed wallet reports anyway.
  // Every payable token’s balance must read, not just one: a EURC wallet whose
  // EURC read failed would otherwise resolve as a USDC wallet holding nothing,
  // and render a cap in the wrong currency rather than admitting it could not
  // tell. Correctness about someone’s spending limit outranks listing it.
  const batches: readonly BatchResult[][] = [owners, signers, policies, spent, ...balancesByToken];
  wallets.forEach((wallet, i) => {
    if (batches.some((batch) => batch[i]?.status !== "success")) {
      failed.push(wallet);
      return;
    }
    // What this wallet holds, across every payable token, so its currency is an
    // observation rather than an assumption.
    const held: Partial<Record<TokenId, bigint>> = {};
    PAYABLE_TOKEN_IDS.forEach((id, t) => {
      held[id] = balancesByToken[t]![i]!.result as bigint;
    });
    const currency = resolveAgentCurrency(held);

    const raw: RawAgentState = {
      wallet,
      owner: owners[i]!.result as Address,
      agentSigner: signers[i]!.result as Address,
      policy: policies[i]!.result as readonly [bigint, bigint, number, bigint],
      spentToday: spent[i]!.result as bigint,
      // Each wallet reports ITS OWN currency, balance and rate. A single shared
      // token here is what would relabel a euro agent’s caps in dollars.
      balance: held[currency.token] ?? 0n,
      token: currency.token,
      heldTokens: currency.held,
      rate: rateOf.get(currency.token)!,
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
