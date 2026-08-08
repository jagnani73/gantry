import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyBudget, msUntilReset, release, reserve } from "../src/services/faucet-budget";

const GRANT = 4_000_000n;
const BUDGET = 20_000_000n; // 5 grants
const WINDOW = 86_400_000;
const T0 = 1_000_000_000_000;

test("unmetered budget always reserves and never accumulates state", () => {
  let state = emptyBudget();
  for (let i = 0; i < 100; i++) {
    const r = reserve(state, GRANT, null, T0 + i, WINDOW);
    assert.equal(r.ok, true);
    state = r.state;
  }
  assert.equal(state.spent, 0n, "unmetered must not track spend");
  assert.equal(state.windowStart, 0, "unmetered must not open a window");
});

test("reserves up to the ceiling, then refuses", () => {
  let state = emptyBudget();
  for (let i = 0; i < 5; i++) {
    const r = reserve(state, GRANT, BUDGET, T0, WINDOW);
    assert.equal(r.ok, true, `grant ${i + 1} of 5 should fit`);
    state = r.state;
  }
  assert.equal(state.spent, BUDGET);

  const over = reserve(state, GRANT, BUDGET, T0, WINDOW);
  assert.equal(over.ok, false);
  assert.equal(over.remaining, 0n);
  assert.equal(over.state.spent, BUDGET, "a refusal must not consume budget");
});

test("a partial grant is refused rather than clipped", () => {
  // 18 of 20 spent: a 4-unit grant does not fit and must not be shaved to 2.
  const state = { windowStart: T0, spent: 18_000_000n };
  const r = reserve(state, GRANT, BUDGET, T0, WINDOW);
  assert.equal(r.ok, false);
  assert.equal(r.remaining, 2_000_000n);
  assert.equal(r.state.spent, 18_000_000n);
});

test("the window rolls exactly at windowMs, not before", () => {
  const spent = { windowStart: T0, spent: BUDGET };

  const justBefore = reserve(spent, GRANT, BUDGET, T0 + WINDOW - 1, WINDOW);
  assert.equal(justBefore.ok, false, "1ms early must still be exhausted");

  const atBoundary = reserve(spent, GRANT, BUDGET, T0 + WINDOW, WINDOW);
  assert.equal(atBoundary.ok, true, "the window rolls at exactly windowMs");
  assert.equal(atBoundary.state.spent, GRANT, "a rolled window starts from this grant");
  assert.equal(atBoundary.state.windowStart, T0 + WINDOW);
});

test("the window runs from the first grant, so it cannot be reset by waiting", () => {
  // Rolling, not calendar-based: spending at T0 and again 23h later leaves the
  // window anchored at T0 — the ceiling covers any 24h span, not a clock day.
  const first = reserve(emptyBudget(), GRANT, BUDGET, T0, WINDOW);
  const later = reserve(first.state, GRANT, BUDGET, T0 + 23 * 3_600_000, WINDOW);
  assert.equal(later.state.windowStart, T0);
  assert.equal(later.state.spent, GRANT * 2n);
});

test("release returns a reservation without going negative", () => {
  const state = { windowStart: T0, spent: GRANT };
  assert.equal(release(state, GRANT).spent, 0n);
  assert.equal(release(state, GRANT * 3n).spent, 0n, "over-release must clamp at zero");
  assert.equal(release(state, GRANT).windowStart, T0, "release must not reopen the window");
});

test("release frees capacity for the next caller", () => {
  let state = emptyBudget();
  for (let i = 0; i < 5; i++) state = reserve(state, GRANT, BUDGET, T0, WINDOW).state;
  assert.equal(reserve(state, GRANT, BUDGET, T0, WINDOW).ok, false);

  state = release(state, GRANT); // a failed transfer gives its grant back
  assert.equal(reserve(state, GRANT, BUDGET, T0, WINDOW).ok, true);
});

test("msUntilReset counts down within a window and is zero before the first grant", () => {
  assert.equal(msUntilReset(emptyBudget(), T0, WINDOW), 0);
  assert.equal(msUntilReset({ windowStart: T0, spent: GRANT }, T0, WINDOW), WINDOW);
  assert.equal(msUntilReset({ windowStart: T0, spent: GRANT }, T0 + 1000, WINDOW), WINDOW - 1000);
  assert.equal(
    msUntilReset({ windowStart: T0, spent: GRANT }, T0 + WINDOW * 2, WINDOW),
    0,
    "an elapsed window must not report negative time",
  );
});
