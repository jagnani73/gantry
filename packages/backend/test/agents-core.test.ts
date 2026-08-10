import assert from "node:assert/strict";
import { test } from "node:test";
import { agentStatus } from "@gantry/shared";
import {
  advanceCursor,
  completeThrough,
  decodeCategories,
  foldWalletCreated,
  isRateLimited,
  pickReportableError,
  runScan,
  sameAddress,
  tileRanges,
  toAgentSummary,
  type CreatedWallet,
  type RawAgentState,
  type ScanRange,
  type WalletCreatedLog,
} from "../src/services/agents-core";

const WALLET = "0xDD4bbed78B64715288bf10fabB2b62c659299D3E" as const;
const OWNER = "0x82513007C7eB93b54dC555Bdb74341b3084FC47B" as const;
const SIGNER = "0x0000000000000000000000000000000000000A11" as const;

/** food_beverage only — the canonical demo policy's bitmap. */
const FOOD = 1n << 1n;

function raw(over: Partial<RawAgentState> = {}): RawAgentState {
  return {
    wallet: WALLET,
    owner: OWNER,
    agentSigner: SIGNER,
    policy: [37_255_049n, 37_255_049n, 1_780_000_000, FOOD],
    spentToday: 3_352_955n,
    balance: 10_000_000n,
    token: "USDC",
    rate: 1_342_100n,
    ...over,
  };
}

test("every amount crosses the wire as a 6dp decimal string, never a number", () => {
  const summary = toAgentSummary(raw());
  for (const field of ["dailyCap", "perTxCap", "spentToday", "balance", "rate", "categoryBitmap"] as const) {
    assert.equal(typeof summary[field], "string", `${field} must be a string`);
  }
  assert.equal(summary.dailyCap, "37255049");
  assert.equal(summary.spentToday, "3352955");
  assert.equal(summary.rate, "1342100");
  // expiry is the one number: it is a unix second, not money.
  assert.equal(summary.expiry, 1_780_000_000);
});

test("a uint256 bitmap survives the round trip that JSON.stringify would not", () => {
  // Bit 255 set: outside anything Number can hold exactly, and the value a
  // bigint left un-stringified would throw on.
  const bitmap = (1n << 255n) | FOOD;
  const summary = toAgentSummary(raw({ policy: [1n, 1n, 1, bitmap] }));
  assert.equal(summary.categoryBitmap, bitmap.toString());
  assert.equal(BigInt(summary.categoryBitmap), bitmap);
});

test("categories decode by bit, and an unknown id renders rather than vanishing", () => {
  assert.deepEqual(decodeCategories(FOOD), ["food_beverage"]);
  assert.deepEqual(decodeCategories(FOOD | (1n << 2n)), ["food_beverage", "electronics"]);
  assert.deepEqual(decodeCategories(0n), []);
  // The owner allowed bit 7; the registry has no name for it. It must still be
  // visible — a silently dropped bit is a permission nobody can see or revoke.
  assert.deepEqual(decodeCategories(1n << 7n), ["category_7"]);
  // Bit 0 is a real bit: GantryCore's ids start at 1 by convention only.
  assert.deepEqual(decodeCategories(1n), ["category_0"]);
});

test("revoked is derived from expiry alone, and is not a status", () => {
  assert.equal(toAgentSummary(raw({ policy: [0n, 0n, 0, 0n] })).revoked, true);
  const lapsed = toAgentSummary(raw({ policy: [1n, 1n, 1_000, FOOD] }));
  assert.equal(lapsed.revoked, false, "a lapsed policy is not revoked");
  // …and this is exactly why a badge must not read `revoked`: the wallet denies
  // every spend here with PolicyExpired while the flag says otherwise.
  assert.equal(agentStatus(lapsed, 2_000), "lapsed");
  assert.equal(agentStatus(toAgentSummary(raw()), 1_700_000_000), "active");
  assert.equal(agentStatus(toAgentSummary(raw({ policy: [0n, 0n, 0, 0n] })), 1_700_000_000), "revoked");
});

test("an undated policy reports null, never a missing key or a guess", () => {
  // The scan is bounded and allowed to come back empty, so "not known" is a
  // normal answer. It has to reach the client as an explicit null: the screen
  // branches on this field to decide whether to render the line at all, and an
  // absent key would read as a policy that has never been changed.
  const undated = toAgentSummary(raw());
  assert.equal(undated.policyUpdatedAt, null);
  assert.ok("policyUpdatedAt" in undated, "the key must be present even when unknown");

  const dated = toAgentSummary({ ...raw(), policyUpdatedAt: 1_780_000_000 });
  assert.equal(dated.policyUpdatedAt, 1_780_000_000);
});

test("expiry is the LAST allowed second, matching authorizeSpend", () => {
  const summary = toAgentSummary(raw({ policy: [1n, 1n, 5_000, FOOD] }));
  assert.equal(agentStatus(summary, 5_000), "active", "now === expiry still spends");
  assert.equal(agentStatus(summary, 5_001), "lapsed");
});

test("address comparison ignores case, because only chain reads are checksummed", () => {
  assert.equal(sameAddress(OWNER, OWNER.toLowerCase() as `0x${string}`), true);
  assert.equal(sameAddress(OWNER, WALLET), false);
});


// ------------------------------------------------------------- chunked scan
//
// Every case below is a wallet that would go invisible if the rule were wrong.

const SPAN = 1_999n;

test("the tiling covers the span with no gap and no overlap", () => {
  for (const [from, head] of [
    [45_133_047n, 45_140_000n],
    [1_000n, 1_000n],
    [0n, 1_999n], // head exactly on a window boundary
    [0n, 2_000n], // one block past one
  ] as const) {
    const ranges = tileRanges(from, head, SPAN);
    assert.ok(ranges.length > 0);
    assert.equal(ranges[0]!.fromBlock, from, "starts at from");
    assert.equal(ranges.at(-1)!.toBlock, head, "ends at head, never past it");
    for (let i = 1; i < ranges.length; i++) {
      // The gap-free property completeThrough's whole answer rests on.
      assert.equal(ranges[i]!.fromBlock, ranges[i - 1]!.toBlock + 1n);
    }
    for (const r of ranges) assert.ok(r.toBlock - r.fromBlock <= SPAN, "no window exceeds the span");
  }
});

test("a span with nothing in it tiles to nothing", () => {
  assert.deepEqual(tileRanges(100n, 99n, SPAN), []);
});

test("a scan with nothing outstanding is complete to the head it read", () => {
  assert.equal(completeThrough([], 100n, 5_000n), 5_000n);
});

test("the cursor stops one block BELOW the lowest outstanding window", () => {
  const ranges = tileRanges(45_133_047n, 45_140_000n, SPAN);
  const pending = ranges.slice(2); // windows 0 and 1 landed — the tail throttle
  const cursor = completeThrough(pending, 45_133_047n, 45_140_000n);
  assert.equal(cursor, pending[0]!.fromBlock - 1n);
  assert.equal(cursor, ranges[1]!.toBlock, "and that is exactly the last block proven read");
});

test("an out-of-order failure is still measured from the LOWEST gap", () => {
  const ranges = tileRanges(1_000n, 12_000n, SPAN);
  // Order is not guaranteed: retry passes rebuild the list from whatever failed.
  const pending = [ranges[4]!, ranges[1]!, ranges[3]!];
  assert.equal(
    completeThrough(pending, 1_000n, 12_000n),
    ranges[1]!.fromBlock - 1n,
    "window 1 is unread, so nothing above it may be claimed even though 2 landed",
  );
});

test("nothing is claimed when the very first window is outstanding", () => {
  const ranges = tileRanges(45_133_047n, 45_140_000n, SPAN);
  assert.equal(completeThrough(ranges, 45_133_047n, 45_140_000n), null);
});

test("a head behind the start claims nothing, so a lagging replica cannot park the cursor", () => {
  // Cold process: from is the factory deploy block. A replica answering with an
  // older head must not set the cursor below it, or the factory range is never
  // scanned again and every payer is told they have no agents.
  assert.equal(completeThrough([], 45_133_047n, 45_000_000n), null);
});

test("the cursor only ever moves forward", () => {
  assert.equal(advanceCursor(null, 500n), 500n, "first result is taken");
  assert.equal(advanceCursor(500n, 900n), 900n, "progress is taken");
  assert.equal(advanceCursor(900n, 500n), 900n, "a lower value is refused");
  assert.equal(advanceCursor(900n, null), 900n, "claiming nothing holds the line");
  assert.equal(advanceCursor(null, null), null);
});

// ------------------------------------------------------------------ the fold

const log = (wallet: string): WalletCreatedLog => ({
  args: { wallet: wallet as `0x${string}`, owner: OWNER, agentSigner: SIGNER },
});

test("a log that did not decode is counted, never silently skipped", () => {
  const into = new Map<string, CreatedWallet>();
  // viem's getLogs is non-strict by default, so an ABI mismatch arrives as {}.
  const { folded, dropped } = foldWalletCreated([log(WALLET), { args: {} }], into);
  assert.equal(folded, 1);
  assert.equal(dropped, 1, "the caller needs this to refuse to advance the cursor");
  assert.equal(into.size, 1);
});

test("the fold keys by lowercased address so a re-read is idempotent", () => {
  const into = new Map<string, CreatedWallet>();
  foldWalletCreated([log(WALLET)], into);
  foldWalletCreated([log(WALLET)], into);
  assert.equal(into.size, 1);
  assert.equal(into.get(WALLET.toLowerCase())?.wallet, WALLET);
});

// --------------------------------------------------------------- the run loop

function harness(
  behaviour: (range: ScanRange, attempt: number) => "ok" | "fail" | "undecodable",
  overrides: Partial<Parameters<typeof runScan>[2]> = {},
  clock = { t: 0 },
) {
  const attempts = new Map<string, number>();
  const concurrencies: number[] = [];
  const sleeps: number[] = [];
  const into = new Map<string, CreatedWallet>();
  let inFlight = 0;
  let peak = 0;

  const deps = {
    fetchRange: async (range: ScanRange) => {
      const key = `${range.fromBlock}`;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight--;
      const verdict = behaviour(range, attempt);
      if (verdict === "fail") throw Object.assign(new Error("over rate limit"), { status: 429 });
      if (verdict === "undecodable") return [{ args: {} }] as WalletCreatedLog[];
      return [log(`0x${range.fromBlock.toString(16).padStart(40, "0")}`)];
    },
    fold: (logs: readonly WalletCreatedLog[]) => foldWalletCreated(logs, into),
    sleep: (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
      return Promise.resolve();
    },
    now: () => clock.t,
    warn: () => {
      concurrencies.push(peak);
      peak = 0;
    },
  };
  const policy = {
    concurrency: 4,
    retryConcurrency: 2,
    backoffsMs: [750, 1_500, 3_000],
    deadlineMs: 15_000,
    ...overrides,
  };
  return { deps, policy, attempts, sleeps, into };
}

test("a window that fails leaves its batch-mates in the cache", async () => {
  const ranges = tileRanges(0n, 7_999n, SPAN); // 4 windows, one batch
  const h = harness((range) => (range.fromBlock === 2_000n ? "fail" : "ok"));
  const outcome = await runScan(ranges, h.deps, h.policy);

  // The whole point of allSettled over all: one throttled window must not
  // discard the three beside it.
  assert.equal(h.into.size, 3, "the three that landed are folded in");
  assert.equal(outcome.pending.length, 1);
  assert.equal(outcome.pending[0]!.fromBlock, 2_000n);
  assert.equal(outcome.stoppedBy, "retries-exhausted");
});

test("a window that recovers on a retry leaves the scan complete", async () => {
  const ranges = tileRanges(0n, 7_999n, SPAN);
  const h = harness((range, attempt) => (range.fromBlock === 2_000n && attempt === 1 ? "fail" : "ok"));
  const outcome = await runScan(ranges, h.deps, h.policy);

  assert.equal(outcome.stoppedBy, "complete");
  assert.equal(outcome.error, null);
  assert.deepEqual(outcome.pending, []);
  assert.equal(h.into.size, 4);
  assert.deepEqual(h.sleeps, [750], "exactly one backoff, before the single retry pass");
});

test("a scan that never recovers gives up after four passes and stays a failure", async () => {
  const ranges = tileRanges(0n, 3_999n, SPAN); // 2 windows
  const h = harness((range) => (range.fromBlock === 2_000n ? "fail" : "ok"));
  const outcome = await runScan(ranges, h.deps, h.policy);

  assert.equal(h.attempts.get("2000"), 4, "pass 0 plus one per backoff, no more");
  assert.deepEqual(h.sleeps, [750, 1_500, 3_000]);
  assert.equal(outcome.stoppedBy, "retries-exhausted");
  assert.ok(outcome.error, "an incomplete scan must carry an error, never report success");
});

test("a first pass that fails EVERYTHING stops at once instead of hammering", async () => {
  const ranges = tileRanges(0n, 19_999n, SPAN); // 10 windows
  const h = harness(() => "fail");
  const outcome = await runScan(ranges, h.deps, h.policy);

  // An outage is not a partial throttle: retrying cannot help, the cursor cannot
  // advance from it (the first window is among the failures), and hammering is
  // the one response that makes a rate limit worse.
  assert.equal(outcome.stoppedBy, "wholesale");
  assert.deepEqual(h.sleeps, [], "no backoff, because no retry was attempted");
  for (const range of ranges) assert.equal(h.attempts.get(`${range.fromBlock}`), 1);
  assert.equal(completeThrough(outcome.pending, 0n, 19_999n), null, "and nothing may be claimed");
});

test("the deadline stops a scan the browser has already given up on", async () => {
  const ranges = tileRanges(0n, 39_999n, SPAN); // 20 windows
  const clock = { t: 0 };
  let ticks = 0;
  const h = harness((range) => (range.fromBlock === 0n ? "fail" : "ok"), { deadlineMs: 100 }, clock);
  // Every clock read advances time, so the budget expires part-way through.
  const timed = { ...h.deps, now: () => (ticks++ > 2 ? 1_000 : clock.t) };
  const outcome = await runScan(ranges, timed, h.policy);

  assert.equal(outcome.stoppedBy, "deadline");
  assert.ok(outcome.pending.length > 0, "unattempted windows stay unread, never skipped");
  assert.ok(h.into.size < 20, "and the scan stopped early rather than running to completion");
});

test("an undecodable window is a failure, not a quiet success", async () => {
  const ranges = tileRanges(0n, 3_999n, SPAN);
  const h = harness((range) => (range.fromBlock === 0n ? "undecodable" : "ok"));
  const outcome = await runScan(ranges, h.deps, h.policy);

  // Counting it as read would advance the cursor past wallets never folded in,
  // and answer {agents: []} with HTTP 200 — the duplicate-wallet outcome with a
  // cursor vouching for it.
  assert.equal(outcome.pending.length, 1);
  assert.equal(outcome.pending[0]!.fromBlock, 0n);
  assert.match(outcome.error?.message ?? "", /did not decode/);
});

// ------------------------------------------------------------- error choice

test("a permanent failure is reported ahead of the transient ones burying it", () => {
  const throttle = Object.assign(new Error("over rate limit"), { status: 429 });
  const permanent = new Error("invalid params: block range too large");
  assert.equal(pickReportableError([throttle, throttle, permanent]), permanent);
  assert.equal(pickReportableError([throttle, throttle]), throttle, "429s are all we have");
  assert.equal(pickReportableError([]), null);
});

test("a rate limit is recognised by status or by message", () => {
  assert.equal(isRateLimited(Object.assign(new Error("nope"), { status: 429 })), true);
  assert.equal(isRateLimited(new Error("Details: over rate limit")), true);
  assert.equal(isRateLimited(new Error("Too Many Requests")), true);
  assert.equal(isRateLimited(new Error("block range too large")), false);
});
