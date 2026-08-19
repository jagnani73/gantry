import { test } from "node:test";
import assert from "node:assert/strict";
import { canAgentSpend, resolveAgentCurrency } from "./agentCurrency";
import { VANILLA_DEFAULT_TOKEN } from "./tokens";

test("an agent's currency is whatever it holds", () => {
  assert.deepEqual(resolveAgentCurrency({ USDC: 10_000_000n }), {
    token: "USDC",
    ambiguous: false,
    held: ["USDC"],
  });
  assert.deepEqual(resolveAgentCurrency({ EURC: 5_000_000n }), {
    token: "EURC",
    ambiguous: false,
    held: ["EURC"],
  });
});

test("an unfunded wallet is not ambiguous, it just has no evidence", () => {
  // The common case: freshly created, or drained by a demo run. Defaulting
  // keeps every screen and every quote on one token until it is funded.
  assert.deepEqual(resolveAgentCurrency({}), { token: "USDC", ambiguous: false, held: [] });
  assert.deepEqual(resolveAgentCurrency({ USDC: 0n, EURC: 0n }), {
    token: "USDC",
    ambiguous: false,
    held: [],
  });
});

test("the unfunded default is the VANILLA one, not whatever TOKENS lists first", () => {
  // PAYABLE_TOKEN_IDS takes its order from the key order of the TOKENS object,
  // so defaulting to [0] meant alphabetising the registry would move every
  // unfunded wallet onto another currency -- relabelling its caps and pointing
  // topUpPbmWallet at the wrong token -- with nobody touching agentCurrency.ts.
  // Asserting the RULE rather than the symptom, so the pin survives a reorder.
  assert.equal(resolveAgentCurrency({}).token, VANILLA_DEFAULT_TOKEN);
});

test("held lists what a screen would have to explain, so ambiguity can be named", () => {
  // `ambiguous` alone says a wallet is unrenderable without saying what it
  // holds, and the flag used to be computed and then dropped before it reached
  // any screen. `held` is what lets one say "this wallet holds USDC and EURC".
  const both = resolveAgentCurrency({ USDC: 1n, EURC: 10_000_000n });
  assert.deepEqual([...both.held], ["USDC", "EURC"]);
  assert.equal(both.ambiguous, true);
});

test("holding two payable tokens is AMBIGUOUS and is never silently resolved", () => {
  // The policy has one dailyCap and one _spentToday counter, so a wallet
  // holding both genuinely conflates them. Picking one and rendering its cap
  // would be wrong for the other, silently.
  const both = resolveAgentCurrency({ USDC: 1n, EURC: 1n });
  assert.equal(both.ambiguous, true);
});

test("a missing key counts as zero rather than throwing", () => {
  // Callers read balances over a multicall with allowFailure, so a token whose
  // read failed is simply absent. An exception there would take out the whole
  // agents list over one flaky call.
  assert.deepEqual(resolveAgentCurrency({ EURC: 7n }), {
    token: "EURC",
    ambiguous: false,
    held: ["EURC"],
  });
});

test("an agent may spend the token it holds", () => {
  assert.deepEqual(canAgentSpend({ USDC: 10_000_000n }, "USDC"), { ok: true });
  assert.deepEqual(canAgentSpend({ EURC: 10_000_000n }, "EURC"), { ok: true });
});

test("an agent may NOT be asked for a token it does not hold", () => {
  // The whole point: a EURC payment counted against a cap denominated in USDC
  // is ~13% wrong at the demo rates, and wrong without saying so.
  const refused = canAgentSpend({ USDC: 10_000_000n }, "EURC");
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.reason, /spends USDC/);
});

test("a wallet holding both is refused whichever token is asked for", () => {
  for (const token of ["USDC", "EURC"] as const) {
    const refused = canAgentSpend({ USDC: 1n, EURC: 1n }, token);
    assert.equal(refused.ok, false, token);
    assert.match(refused.ok ? "" : refused.reason, /more than one payable token/);
  }
});

test("an empty wallet may be quoted in anything", () => {
  // It fails the balance check on-chain, which is a correct and specific
  // refusal — InsufficientWalletBalance names the real problem, where a
  // client-side "wrong currency" would not.
  assert.deepEqual(canAgentSpend({}, "EURC"), { ok: true });
  assert.deepEqual(canAgentSpend({ USDC: 0n }, "EURC"), { ok: true });
});
