import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DISPLAY_CURRENCIES,
  DISPLAY_CURRENCY_CODES,
  currencyToken,
  isDisplayCurrencyCode,
  isExact,
  referenceAmount,
  settlementSendToken,
} from "./currency";
import { DEMO_RATE } from "./constants";
import { TOKENS } from "./tokens";
import { quoteAmountIn } from "./quote";

const SGD = DISPLAY_CURRENCIES.SGD;
const USD = DISPLAY_CURRENCIES.USD;
const EUR = DISPLAY_CURRENCIES.EUR;
const INR = DISPLAY_CURRENCIES.INR;

test("SGD is the settlement unit and converts to itself", () => {
  assert.equal(referenceAmount(1_500_000n, SGD, DEMO_RATE), 1_500_000n);
  // ...including with no rate available at all, because none is needed.
  assert.equal(referenceAmount(1_500_000n, SGD, null), 1_500_000n);
});

test("USD reads the on-chain rate and matches what the payer will sign", () => {
  // The canonical demo payment: S$1.50 quotes to 1.117652 USDC, and the
  // reference figure a payer sees must not contradict the amount on the
  // authorization. Quote CEILs, reference ROUNDS, so they may differ by one
  // unit at 6dp — never more.
  const xsgd = 1_500_000n;
  const shown = referenceAmount(xsgd, USD, DEMO_RATE);
  const signed = quoteAmountIn(xsgd, DEMO_RATE);
  assert.ok(shown !== null);
  const drift = shown > signed ? shown - signed : signed - shown;
  assert.ok(drift <= 1n, `reference ${shown} drifted ${drift} from signed ${signed}`);
});

test("an on-chain currency with no rate is unavailable, never approximated", () => {
  // The failure that matters: a dropped rate must not silently fall back to an
  // indicative number, because a payer cannot tell the two apart on screen.
  assert.equal(referenceAmount(1_500_000n, USD, null), null);
  assert.equal(referenceAmount(1_500_000n, USD, 0n), null);
  // An indicative currency is unaffected — it never needed the rate.
  assert.equal(referenceAmount(1_500_000n, INR, null), 97_500_000n);
});

test("indicative conversion is the round rate, applied exactly", () => {
  assert.equal(referenceAmount(1_000_000n, INR, null), 65_000_000n); // S$1 → ₹65
  assert.equal(referenceAmount(1_500_000n, INR, null), 97_500_000n); // S$1.50 → ₹97.50
  assert.equal(referenceAmount(4_500_000n, INR, null), 292_500_000n); // the agent basket
  assert.equal(referenceAmount(1_000_000n, EUR, null), 700_000n); // S$1 → €0.70
});

test("rounds half-up rather than truncating", () => {
  // 3 XSGD units at 0.70 = 2.1 units. Truncation gives 2; half-up gives 2.
  assert.equal(referenceAmount(3n, EUR, null), 2n);
  // 5 units at 0.70 = 3.5 → 4 under half-up, 3 under truncation.
  assert.equal(referenceAmount(5n, EUR, null), 4n);
});

test("zero is representable; negative input is refused", () => {
  assert.equal(referenceAmount(0n, INR, null), 0n);
  assert.equal(referenceAmount(0n, USD, DEMO_RATE), 0n);
  assert.equal(referenceAmount(-1n, INR, null), null);
});

test("provenance is derivable and honest for every currency", () => {
  // The invariant the UI leans on: exactly the indicative ones are inexact,
  // and exactly the on-chain ones name a token.
  assert.equal(isExact(SGD), true);
  assert.equal(isExact(USD), true);
  assert.equal(isExact(EUR), false);
  assert.equal(isExact(INR), false);

  assert.equal(currencyToken(USD), "USDC");
  assert.equal(currencyToken(SGD), null);
  assert.equal(currencyToken(INR), null);
});

test("every on-chain currency names a token that exists and is payable", () => {
  // Guards the EURC upgrade path: flipping EUR to `onchain` without adding the
  // token to TOKENS, or without marking it payable, fails here rather than at
  // runtime on the one screen a payer signs from.
  for (const code of DISPLAY_CURRENCY_CODES) {
    const token = currencyToken(DISPLAY_CURRENCIES[code]);
    if (token === null) continue;
    assert.ok(TOKENS[token], `${code} names unknown token ${token}`);
    assert.equal(TOKENS[token].payable, true, `${code} names non-payable token ${token}`);
  }
});

test("the code table is self-consistent", () => {
  for (const code of DISPLAY_CURRENCY_CODES) {
    assert.equal(DISPLAY_CURRENCIES[code].code, code);
    assert.ok(DISPLAY_CURRENCIES[code].symbol.length > 0);
    assert.equal(isDisplayCurrencyCode(code), true);
  }
  assert.equal(isDisplayCurrencyCode("GBP"), false);
  assert.equal(isDisplayCurrencyCode(""), false);
});

test("exactly one currency is settleable today, and it is USD", () => {
  // The fact every "you will send X" line on the payer app depends on. If a
  // second token is ever listed this test fails, which is the point: the copy
  // promising USDC has to be revisited in the same change.
  const settleable = DISPLAY_CURRENCY_CODES.filter((c) => DISPLAY_CURRENCIES[c].settleable);
  assert.deepEqual(settleable, ["USD"]);
});

test("a settleable currency must name a payable token", () => {
  for (const code of DISPLAY_CURRENCY_CODES) {
    const currency = DISPLAY_CURRENCIES[code];
    if (!currency.settleable) continue;
    const token = currencyToken(currency);
    assert.ok(token, `${code} is settleable but names no token`);
    assert.equal(TOKENS[token].payable, true, `${code} settles in a non-payable token`);
  }
});

test("SGD is never settleable — the settlement token has an open mint", () => {
  // MockXSGD is `payable: false` in TOKENS for that reason, and offering SGD as
  // a way to PAY would route straight around that guard.
  assert.equal(DISPLAY_CURRENCIES.SGD.settleable, false);
  assert.equal(TOKENS.MockXSGD.payable, false);
});

test("the send token is USDC for every currency until another is listed", () => {
  for (const code of DISPLAY_CURRENCY_CODES) {
    assert.equal(
      settlementSendToken(DISPLAY_CURRENCIES[code]),
      "USDC",
      `${code} promised a send token other than USDC`,
    );
  }
});

test("SGD is the only settlement currency", () => {
  // More than one would mean the merchant's payout could differ by screen,
  // which GantryCore's immutable XSGD makes impossible.
  const settlement = DISPLAY_CURRENCY_CODES.filter(
    (c) => DISPLAY_CURRENCIES[c].source.kind === "settlement",
  );
  assert.deepEqual(settlement, ["SGD"]);
});
