import type { Address } from "viem";
import { categoryName, type AgentSummary, type TokenId } from "@gantry/shared";

/**
 * The pure half of the agent read path — raw chain values in, AgentSummary out,
 * no client and no config — so the shaping can be tested without a chain. Same
 * split as facilitator-core and pbm-core.
 */

/** One wallet's reads, exactly as the contracts return them. */
export interface RawAgentState {
  wallet: Address;
  /** Live `owner()`, not the factory's record of who created it — see agents.ts. */
  owner: Address;
  agentSigner: Address;
  /** `AgentPBMWallet.policy()`: dailyCap, perTxCap, expiry, categoryBitmap.
   * expiry is a uint40, which viem widens to a number rather than a bigint. */
  policy: readonly [bigint, bigint, number, bigint];
  spentToday: bigint;
  balance: bigint;
  token: TokenId;
  /** XSGD 6dp out per 1e6 token units — the OWNER-SET rate, not a market one. */
  rate: bigint;
}

/**
 * Names for every set bit. GantryCore caps categoryId < 256, so no higher bit
 * can ever gate a real merchant. An id inside that range that the registry does
 * not know still renders (`category_7`) instead of vanishing: the owner allowed
 * it, so the owner has to be able to see that they did.
 */
export function decodeCategories(bitmap: bigint): string[] {
  const names: string[] = [];
  for (let id = 0; id < 256; id++) {
    if ((bitmap >> BigInt(id)) & 1n) names.push(categoryName(id));
  }
  return names;
}

/** Case-insensitive address equality. Addresses arrive from three spellings —
 * a query string, a route segment and a chain read — and only the last is
 * reliably checksummed. */
export function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function toAgentSummary(raw: RawAgentState): AgentSummary {
  const [dailyCap, perTxCap, expiry, categoryBitmap] = raw.policy;
  return {
    wallet: raw.wallet,
    owner: raw.owner,
    agentSigner: raw.agentSigner,
    dailyCap: dailyCap.toString(),
    perTxCap: perTxCap.toString(),
    spentToday: raw.spentToday.toString(),
    expiry: Number(expiry),
    categoryBitmap: categoryBitmap.toString(),
    categories: decodeCategories(categoryBitmap),
    token: raw.token,
    balance: raw.balance.toString(),
    rate: raw.rate.toString(),
    // Derived, and never a second source of truth: the contract has no revoked
    // flag — revoke() just zeroes expiry. A policy that merely LAPSED denies
    // every spend with this still false, which is why a status badge must come
    // from agentStatus() and not from here.
    revoked: Number(expiry) === 0,
  };
}

// ------------------------------------------------------- chunked factory scan
//
// The pure half of the WalletCreated enumeration: tiling, cursor arithmetic, the
// log fold, and the retry orchestration with its I/O injected. `agents.ts` keeps
// only the wiring, so every rule below is reachable from a test without a chain.

/** One getLogs window. Readonly because a list of these is only meaningful as a
 * tiling: mutating one member's bounds after the fact silently changes what
 * `completeThrough` takes a minimum over. */
export interface ScanRange {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

/** A wallet as the factory's creation log reports it. */
export interface CreatedWallet {
  wallet: Address;
  /** Owner AT CREATION. Ownership is transferable, so this is a candidate, not
   * an answer — the live `owner()` read decides. */
  owner: Address;
  /** Likewise: `setAgentSigner` can rotate the key after creation. */
  agentSigner: Address;
}

/** Structural shape of a decoded WalletCreated log. Every arg is optional
 * because viem's non-strict decoding yields `args: {}` rather than throwing. */
export interface WalletCreatedLog {
  args: { owner?: Address; agentSigner?: Address; wallet?: Address };
}

/**
 * Tiles `[from, head]` into windows spanning at most `span + 1` blocks.
 *
 * Exported, and used by BOTH `scanFactory` and its tests, because
 * `completeThrough`'s correctness is a property of this exact tiling — its
 * answer is only true if the windows are gap-free. A test that rebuilds the
 * tiling locally proves the literals agree with themselves and nothing about
 * the scan (the point `test/faucet-core.test.ts` already makes about the faucet).
 */
export function tileRanges(from: bigint, head: bigint, span: bigint): ScanRange[] {
  const ranges: ScanRange[] = [];
  for (let start = from; start <= head; start = start + span + 1n) {
    const end = start + span;
    ranges.push({ fromBlock: start, toBlock: end > head ? head : end });
  }
  return ranges;
}

/**
 * How far a chunked scan may claim to be COMPLETE, given the windows still
 * outstanding after every retry pass.
 *
 * PRECONDITION: the windows must COVER `[from, head]` WITH NO GAPS, and
 * `pending` must be every one of them that failed. Gap-freeness is the whole
 * requirement — `[100,199]` and `[300,399]` with the second pending answers 299
 * while 200..299 was never requested. Ordering and disjointness are NOT
 * requirements (the answer is a minimum, and any window below that minimum
 * succeeded by definition), so do not add them back on the theory that they are.
 *
 * The dangerous edit this invites is dropping a stubborn window from `pending`
 * to let the rest of the page through: that silently over-claims, and the
 * wallets in it are invisible for the life of the process.
 *
 * The off-by-one is the part that matters. `lowest - 1` is the last block a
 * successful window covered; returning `lowest` would place the cursor INSIDE an
 * unread window, and an agents screen would tell someone with an agent that they
 * have none — which is how a payer creates a duplicate wallet for a signer.
 *
 * Null means nothing may be claimed, which happens exactly when the FIRST window
 * is outstanding. (On a resume that window also spans the re-read slack, but
 * that is the same case, not a second one.)
 */
export function completeThrough(
  pending: readonly ScanRange[],
  from: bigint,
  head: bigint,
): bigint | null {
  // A head below `from` means a lagging replica, not progress. Claiming it would
  // park the cursor below the deploy block on a cold process, and every later
  // scan would resume from there and never re-read the real span.
  if (head < from) return null;
  if (pending.length === 0) return head;
  let lowest = pending[0]!.fromBlock;
  for (const range of pending) if (range.fromBlock < lowest) lowest = range.fromBlock;
  const covered = lowest - 1n;
  return covered >= from ? covered : null;
}

/** Monotonic advance. The cursor may only ever move forward: `from` deliberately
 * re-reads ground already covered, and a lagging replica can report a lower head,
 * so both can compute a value behind the one already held. */
export function advanceCursor(current: bigint | null, covered: bigint | null): bigint | null {
  if (covered === null) return current;
  if (current === null || covered > current) return covered;
  return current;
}

/**
 * Folds creation logs into the cache, reporting how many were DROPPED.
 *
 * The drop count is the load-bearing return value. viem's `getLogs` defaults to
 * `strict: false`, so a log that does not match the ABI comes back with
 * `args: {}` instead of throwing — and a silent `continue` would then mark the
 * window successful, advance the cursor past it, and answer `{agents: []}` with
 * HTTP 200. That is the duplicate-wallet outcome with a cursor vouching for it,
 * so the caller must treat a non-zero drop as a FAILED window rather than a
 * quiet no-op. (`strict: true` is not the fix: it filters undecodable logs out
 * just as silently.)
 */
export function foldWalletCreated(
  logs: readonly WalletCreatedLog[],
  into: Map<string, CreatedWallet>,
): { folded: number; dropped: number } {
  let folded = 0;
  let dropped = 0;
  for (const { args } of logs) {
    if (!args?.owner || !args.agentSigner || !args.wallet) {
      dropped++;
      continue;
    }
    into.set(args.wallet.toLowerCase(), {
      wallet: args.wallet,
      owner: args.owner,
      agentSigner: args.agentSigner,
    });
    folded++;
  }
  return { folded, dropped };
}

/** Is this failure the node saying "slow down"? */
export function isRateLimited(err: Error): boolean {
  if ((err as { status?: unknown }).status === 429) return true;
  return /rate limit|too many requests/i.test(err.message);
}

/**
 * Which failure to report. A throttled scan produces a pile of identical 429s,
 * so taking the first by array position would bury a PERMANENT failure — a
 * malformed range, a bad ABI — behind a transient one, and send the operator off
 * to wait out a rate limit that was never the problem.
 */
export function pickReportableError(errors: readonly Error[]): Error | null {
  if (errors.length === 0) return null;
  return errors.find((err) => !isRateLimited(err)) ?? errors[0]!;
}

function asError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  // Keep the original as `cause` — `String(reason)` on an object is
  // "[object Object]", and this branch exists precisely for the odd shapes.
  return new Error(`getLogs rejected with a non-Error: ${JSON.stringify(reason) ?? String(reason)}`, {
    cause: reason,
  });
}

/** Why a scan stopped, so the log line can say something an operator can act on. */
export type ScanStop = "complete" | "deadline" | "wholesale" | "retries-exhausted";

export interface ScanOutcome {
  /** Windows still unread. Empty iff `stoppedBy === "complete"`. */
  pending: ScanRange[];
  /** Null iff complete. */
  error: Error | null;
  stoppedBy: ScanStop;
}

export interface ScanDeps {
  fetchRange(range: ScanRange): Promise<readonly WalletCreatedLog[]>;
  fold(logs: readonly WalletCreatedLog[]): { folded: number; dropped: number };
  sleep(ms: number): Promise<void>;
  now(): number;
  warn(message: string): void;
}

export interface ScanPolicy {
  concurrency: number;
  retryConcurrency: number;
  backoffsMs: readonly number[];
  deadlineMs: number;
}

/**
 * Runs the tiling, retrying only what failed, under a wall-clock budget.
 *
 * Three ways to stop early, and each exists because the naive loop makes a
 * throttled node WORSE. viem's `fallback` gives every window 2 transports x 4
 * attempts, so one failed window is already up to 8 HTTP requests; multiplying
 * that by four passes over a full tiling is thousands of requests from one
 * egress IP, long after the browser gave up at its own 20s timeout.
 *
 * - `deadline`: checked between batches AND before each sleep, so the budget
 *   bounds the whole scan rather than one pass of it.
 * - `wholesale`: if the FIRST pass fails every window it attempted, that is an
 *   outage signature, not a partial throttle. Retrying cannot help, the cursor
 *   cannot advance from it anyway (the first window is among the failures), and
 *   hammering is the one response that makes it worse.
 * - `retries-exhausted`: the ordinary tail case, bounded by `backoffsMs.length`.
 *
 * The pass count is `backoffsMs.length + 1`, and the guard is written as
 * `pass >= backoffsMs.length` rather than an undefined-check on the lookup:
 * `noUncheckedIndexedAccess` is off repo-wide, so an out-of-range index types as
 * `number` and the compiler would believe the loop never terminates.
 */
export async function runScan(
  ranges: readonly ScanRange[],
  deps: ScanDeps,
  policy: ScanPolicy,
): Promise<ScanOutcome> {
  const startedAt = deps.now();
  const outOfTime = () => deps.now() - startedAt >= policy.deadlineMs;
  const errors: Error[] = [];

  let pending: readonly ScanRange[] = ranges;
  for (let pass = 0; ; pass++) {
    const attempted = pending.length;
    const concurrency = pass === 0 ? policy.concurrency : policy.retryConcurrency;
    const failed: ScanRange[] = [];

    for (let i = 0; i < pending.length; i += concurrency) {
      if (outOfTime()) {
        // Anything not yet attempted stays unread — never silently skipped.
        failed.push(...pending.slice(i));
        return { pending: failed, error: pickReportableError(errors), stoppedBy: "deadline" };
      }
      const slice = pending.slice(i, i + concurrency);
      const settled = await Promise.allSettled(slice.map((range) => deps.fetchRange(range)));
      settled.forEach((outcome, j) => {
        const range = slice[j]!;
        if (outcome.status === "rejected") {
          failed.push(range);
          errors.push(asError(outcome.reason));
          return;
        }
        const { dropped } = deps.fold(outcome.value);
        if (dropped > 0) {
          failed.push(range);
          errors.push(
            new Error(
              `${dropped} WalletCreated log(s) in ${range.fromBlock}..${range.toBlock} did not decode — check the factory ABI`,
            ),
          );
        }
      });
    }

    pending = failed;
    if (pending.length === 0) return { pending: [], error: null, stoppedBy: "complete" };
    if (pass === 0 && attempted > 1 && pending.length === attempted) {
      return { pending: [...pending], error: pickReportableError(errors), stoppedBy: "wholesale" };
    }
    if (pass >= policy.backoffsMs.length || outOfTime()) {
      return {
        pending: [...pending],
        error: pickReportableError(errors),
        stoppedBy: pass >= policy.backoffsMs.length ? "retries-exhausted" : "deadline",
      };
    }
    const backoff = policy.backoffsMs[pass]!;
    // Denominator is what THIS pass attempted: "2/54" on pass 3 would render a
    // 100% failure rate as 3.7%.
    deps.warn(`${pending.length}/${attempted} factory scan chunks failed, retrying in ${backoff}ms`);
    await deps.sleep(backoff);
  }
}
