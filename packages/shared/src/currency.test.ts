import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DISPLAY_CURRENCIES,
  PAYABLE_CURRENCY_CODES,
  SEND_CURRENCY_OPTIONS,
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
});

test("rounds half-up rather than truncating", () => {
  // INR at 65.00 per XSGD, the last indicative currency. 1 unit = 65; the
  // interesting cases are the halves.
  // 1 XSGD unit at 65 = 65 exactly.
  assert.equal(referenceAmount(1n, INR, null), 65n);
  // A half lands up rather than being truncated away.
  assert.equal(referenceAmount(1n, { ...INR, source: { kind: "indicative", perSgd: 1_500_000n } }, null), 2n);
  assert.equal(referenceAmount(1n, { ...INR, source: { kind: "indicative", perSgd: 400_000n } }, null), 0n);
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
  assert.equal(isExact(EUR), true, "EUR is on-chain since EURC was listed");
  assert.equal(isExact(INR), false);

  assert.equal(currencyToken(USD), "USDC");
  assert.equal(currencyToken(EUR), "EURC");
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

test("the settleable set is USD and EUR, and every entry is a real token", () => {
  // Every "you will send X" line on the payer app depends on this. It is pinned
  // as an explicit list rather than a count so that listing a third token is a
  // deliberate edit here, in the same change as the copy it invalidates.
  const settleable = DISPLAY_CURRENCY_CODES.filter((c) => DISPLAY_CURRENCIES[c].settleable);
  assert.deepEqual(settleable, ["USD", "EUR"]);
  // Neither is a mock. MockXSGD stays the only mocked token in the system, and
  // that sentence is load-bearing in the project's honest-labels list.
  assert.deepEqual(settleable.map((c) => currencyToken(DISPLAY_CURRENCIES[c])), ["USDC", "EURC"]);
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

test("the send token follows the currency, and falls back for a preview", () => {
  // The feature in one assertion: choosing euros changes the token on the
  // signature. A currency that cannot be sent must still leave the payer able
  // to pay, so it falls back rather than resolving to nothing.
  assert.equal(settlementSendToken(USD), "USDC");
  assert.equal(settlementSendToken(EUR), "EURC");
  assert.equal(settlementSendToken(INR), "USDC", "a preview still sends the default");
  assert.equal(settlementSendToken(SGD), "USDC", "the output currency is not a way to pay");
});

test("SGD is the only settlement currency", () => {
  // More than one would mean the merchant's payout could differ by screen,
  // which GantryCore's immutable XSGD makes impossible.
  const settlement = DISPLAY_CURRENCY_CODES.filter(
    (c) => DISPLAY_CURRENCIES[c].source.kind === "settlement",
  );
  assert.deepEqual(settlement, ["SGD"]);
});

test("the picker offers what can be sent, and locks the rest rather than hiding it", () => {
  // "Any currency in" is the claim, so a reader deserves to see which
  // currencies that is true of today AND which are coming. Hiding the locked
  // ones would be tidier and would quietly imply the set is closed.
  assert.deepEqual(
    SEND_CURRENCY_OPTIONS.map((o) => `${o.code}${o.locked ? " (locked)" : ""}`),
    ["USD", "EUR", "INR (locked)"],
  );
});

test("SGD is never offered as a way to pay", () => {
  // It is the OUTPUT. GantryCore.XSGD is immutable and the settlement token is
  // non-payable, so offering it would be a button that cannot work.
  assert.ok(!SEND_CURRENCY_OPTIONS.some((o) => o.code === "SGD"));
  assert.ok(!PAYABLE_CURRENCY_CODES.includes("SGD"));
});

test("every offered live option is genuinely settleable", () => {
  // The picker's unlocked entries and the settleable flag cannot drift: an
  // unlocked currency that is not settleable would take a payer to a signing
  // screen for a token no swap will accept.
  for (const option of SEND_CURRENCY_OPTIONS) {
    assert.equal(
      DISPLAY_CURRENCIES[option.code].settleable,
      !option.locked,
      `${option.code} is offered as ${option.locked ? "locked" : "live"} but settleable says otherwise`,
    );
  }
  assert.deepEqual([...PAYABLE_CURRENCY_CODES], ["USD", "EUR"]);
});
