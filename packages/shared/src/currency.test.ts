import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DISPLAY_CURRENCIES,
  PAYABLE_CURRENCY_CODES,
  SEND_CURRENCY_OPTIONS,
  DISPLAY_CURRENCY_CODES,
  isDisplayCurrencyCode,
  settlementSendToken,
} from "./currency";
import { OFFER_TOKEN_IDS, PAYABLE_TOKEN_IDS, TOKENS, VANILLA_DEFAULT_TOKEN } from "./tokens";

const SGD = DISPLAY_CURRENCIES.SGD;
const USD = DISPLAY_CURRENCIES.USD;
const EUR = DISPLAY_CURRENCIES.EUR;
const INR = DISPLAY_CURRENCIES.INR;

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
  assert.deepEqual(
    settleable.map((c) => settlementSendToken(DISPLAY_CURRENCIES[c])),
    ["USDC", "EURC"],
  );
});

test("a settleable currency must name a PAYABLE token", () => {
  // The union guarantees a settleable currency names SOME token; it cannot
  // say which. Naming a non-payable one would take a payer to a signing screen
  // for an asset the quote path refuses — so that half is pinned here.
  for (const code of DISPLAY_CURRENCY_CODES) {
    const currency = DISPLAY_CURRENCIES[code];
    if (!currency.settleable) continue;
    assert.ok(TOKENS[currency.token], `${code} names unknown token ${currency.token}`);
    assert.equal(
      TOKENS[currency.token].payable,
      true,
      `${code} settles in a non-payable token`,
    );
  }
});

test("an unsettleable currency names NO token, so it cannot leak into a signature", () => {
  // This is the union doing the work: `settleable: true` without a token, or
  // SGD flipped to settleable, is now a type error rather than a screen that
  // labels everything in S$ and signs USDC.
  for (const code of DISPLAY_CURRENCY_CODES) {
    const currency = DISPLAY_CURRENCIES[code];
    if (currency.settleable) continue;
    assert.equal(currency.token, null, `${code} is not settleable but names a token`);
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
  assert.equal(settlementSendToken(INR), VANILLA_DEFAULT_TOKEN, "a locked currency still lets them pay");
  assert.equal(settlementSendToken(SGD), VANILLA_DEFAULT_TOKEN, "the output is not a way to pay");
});

test("SGD is never settleable, and is the shop's currency rather than a payer's", () => {
  // The merchant's payout cannot differ by screen — GantryCore.XSGD is
  // immutable — so SGD exists here only to be shown, never to be sent.
  assert.equal(SGD.settleable, false);
  assert.equal(SGD.token, null);
  assert.equal(settlementSendToken(SGD), VANILLA_DEFAULT_TOKEN);
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

// ------------------------------------------------- the one order offers use

test("the offer order leads with the vanilla default and loses no currency", () => {
  // Two surfaces build offers from this — the 402's accepts[] and the discovery
  // listing — and they describe the SAME resource. A listing advertising fewer
  // currencies than the challenge it points at tells a euro-only agent the shop
  // cannot take its money, which is exactly what happened when only `exact`
  // learned to fan out.
  assert.equal(OFFER_TOKEN_IDS[0], VANILLA_DEFAULT_TOKEN);
  assert.deepEqual([...OFFER_TOKEN_IDS].sort(), [...PAYABLE_TOKEN_IDS].sort());
  assert.equal(new Set(OFFER_TOKEN_IDS).size, OFFER_TOKEN_IDS.length, "no duplicates");
});

test("the vanilla default is itself payable", () => {
  // accepts[0] naming a token the quote path refuses is a 402 nobody can pay,
  // produced by a server that thinks it is fine.
  assert.ok(PAYABLE_TOKEN_IDS.includes(VANILLA_DEFAULT_TOKEN));
});
