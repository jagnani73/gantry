import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteAmountIn, parseSgd, formatUnits6 } from "./quote";
import { DEMO_RATE } from "./constants";

test("canonical demo quote: S$6.50 @ 1.3421 → 4_843_157 USDC units", () => {
  assert.equal(quoteAmountIn(6_500_000n, DEMO_RATE), 4_843_157n);
});

test("ceil quote always covers the price (swap floor math)", () => {
  for (const xsgd of [1n, 999_999n, 6_500_000n, 19_500_000n, 123_456_789n]) {
    const amountIn = quoteAmountIn(xsgd, DEMO_RATE);
    const xsgdOut = (amountIn * DEMO_RATE) / 1_000_000n; // FixedRateSwap floors
    assert.ok(xsgdOut >= xsgd, `xsgdOut ${xsgdOut} < ${xsgd}`);
  }
});

test("quote rejects non-positive inputs", () => {
  assert.throws(() => quoteAmountIn(0n, DEMO_RATE));
  assert.throws(() => quoteAmountIn(6_500_000n, 0n));
});

test("parseSgd", () => {
  assert.equal(parseSgd("6.50"), 6_500_000n);
  assert.equal(parseSgd("19.50"), 19_500_000n);
  assert.equal(parseSgd("6"), 6_000_000n);
  assert.equal(parseSgd("0.000001"), 1n);
  assert.throws(() => parseSgd(""));
  assert.throws(() => parseSgd("-1"));
  assert.throws(() => parseSgd("6.5000001"));
  assert.throws(() => parseSgd("6,50"));
});

test("formatUnits6", () => {
  assert.equal(formatUnits6(6_500_001n), "6.50");
  assert.equal(formatUnits6(6_500_001n, 6), "6.500001");
  assert.equal(formatUnits6(4_843_157n, 6), "4.843157");
  assert.equal(formatUnits6(0n), "0.00");
});
