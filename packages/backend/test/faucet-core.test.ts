import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUDGET_WINDOW_MS,
  ETH_TARGET,
  FUNDER_ETH_RESERVE,
  GAS_COOLDOWN_MS,
  GRANT,
  PUBLIC_GAS_DAILY_BUDGET,
  PUBLIC_USDC_DAILY_BUDGET,
  USDC_COOLDOWN_MS,
  createFaucetLeg,
  createFaucetLegs,
  faucetCeilings,
  funderCanSend,
  gasTopUpAmount,
} from "../src/services/faucet-core";

/**
 * Every number here is IMPORTED. The previous version of this file re-declared
 * the constants locally and then did arithmetic on its own literals, which
 * proves the literals agree with themselves and nothing about the faucet — and
 * its "budget independence" test built two fresh objects, exhausted one and
 * asserted the other still worked, which is true of any implementation at all.
 *
 * `createFaucetLegs` is what faucet.ts actually constructs, so exercising it is
 * exercising the wiring: which ceiling each leg got, and whether the two share
 * any state.
 */

const T0 = 1_000_000_000_000;
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** Distinct keys, because the ceiling is global and the cooldown is not — this
 * is the shape of five different payers spending one day's allowance. */
const payer = (i: number): string => `0x${i.toString(16).padStart(40, "0")}`;

// ------------------------------------------------------------- the pure rules

test("a payer already holding the target gets nothing", () => {
  assert.equal(gasTopUpAmount(ETH_TARGET, ETH_TARGET), 0n);
  assert.equal(gasTopUpAmount(ETH_TARGET * 5n, ETH_TARGET), 0n);
});

test("a top-up sends the shortfall, not a flat grant", () => {
  assert.equal(gasTopUpAmount(0n, ETH_TARGET), ETH_TARGET);
  assert.equal(gasTopUpAmount(ETH_TARGET - 1n, ETH_TARGET), 1n);
  assert.equal(gasTopUpAmount(ETH_TARGET / 2n, ETH_TARGET), ETH_TARGET / 2n);
});

test("repeat taps cannot ladder the relayer's ETH away", () => {
  // The property the whole design rests on: fund once, then ask again forever.
  let balance = 0n;
  let sent = 0n;
  for (let i = 0; i < 50; i++) {
    const send = gasTopUpAmount(balance, ETH_TARGET);
    sent += send;
    balance += send;
  }
  assert.equal(sent, ETH_TARGET, "fifty taps must cost exactly one top-up");
});

test("an unconfirmable send self-corrects instead of doubling up", () => {
  // The ambiguous case: we could not prove the transfer landed, so nothing is
  // re-sent and nothing is refunded. If it DID land, the next call sees it.
  const send = gasTopUpAmount(0n, ETH_TARGET);
  assert.equal(gasTopUpAmount(send, ETH_TARGET), 0n, "a landed top-up ends the sequence");
  // And if it did not land, the next call simply completes it.
  assert.equal(gasTopUpAmount(0n, ETH_TARGET), ETH_TARGET);
});

test("the funder reserve is a floor on what is LEFT, not a cap on the spend", () => {
  assert.equal(funderCanSend(FUNDER_ETH_RESERVE + ETH_TARGET, ETH_TARGET, FUNDER_ETH_RESERVE), true);
  assert.equal(
    funderCanSend(FUNDER_ETH_RESERVE + ETH_TARGET - 1n, ETH_TARGET, FUNDER_ETH_RESERVE),
    false,
  );
  // Sitting exactly on the reserve means every top-up is refused — correct: the
  // gas key relaying is worth more than any one payer configuring an agent.
  assert.equal(funderCanSend(FUNDER_ETH_RESERVE, 1n, FUNDER_ETH_RESERVE), false);
  assert.equal(funderCanSend(0n, 0n, FUNDER_ETH_RESERVE), false);
});

// ------------------------------------------------------------- the ceilings

test("each public ceiling is five of the thing it meters", () => {
  // Not literals restated here: the real ceilings divided by the real grant
  // sizes. Change either number without the other and this fails.
  assert.equal(PUBLIC_USDC_DAILY_BUDGET / GRANT, 5n);
  assert.equal(PUBLIC_USDC_DAILY_BUDGET % GRANT, 0n);
  assert.equal(PUBLIC_GAS_DAILY_BUDGET / ETH_TARGET, 5n);
  assert.equal(PUBLIC_GAS_DAILY_BUDGET % ETH_TARGET, 0n);
  // Five gas top-ups must stay well under the floor the funder keeps, or the
  // ceiling would be meaningless — FunderGasLow would bite first.
  assert.equal(PUBLIC_GAS_DAILY_BUDGET < FUNDER_ETH_RESERVE, true);
});

test("a demo host is unmetered on both legs; a public host is metered on both", () => {
  assert.deepEqual(faucetCeilings(true), { usdc: null, gas: null });
  assert.deepEqual(faucetCeilings(false), {
    usdc: PUBLIC_USDC_DAILY_BUDGET,
    gas: PUBLIC_GAS_DAILY_BUDGET,
  });
});

// ---------------------------------------------------- the legs, as wired

/**
 * The typo this exists for: pointing the gas leg at the USDC ceiling. It is one
 * character in faucet-core, both fields are `bigint | null`, and nothing throws
 * — 2×10¹⁵ wei simply never fits inside 20,000,000, so every gas top-up on a
 * public host is silently refused and `FaucetResponse` does not report it.
 */
test("the gas leg is metered in WEI, not in USDC units", () => {
  const legs = createFaucetLegs(false);
  assert.equal(
    legs.gas.claim(A, ETH_TARGET, T0),
    null,
    "a first 0.002 ETH top-up must fit — if it does not, the gas leg is reading the USDC ceiling",
  );
});

test("the gas leg's ceiling is five full top-ups on a public host", () => {
  const legs = createFaucetLegs(false);
  for (let i = 0; i < 5; i++) {
    assert.equal(legs.gas.claim(payer(i), ETH_TARGET, T0), null, `top-up ${i + 1} of 5 should fit`);
  }
  const sixth = legs.gas.claim(payer(99), ETH_TARGET, T0);
  assert.deepEqual(sixth, { kind: "budget", remaining: 0n, resetInMs: BUDGET_WINDOW_MS });
});

test("the USDC leg's ceiling is five full grants on a public host", () => {
  const legs = createFaucetLegs(false);
  for (let i = 0; i < 5; i++) {
    assert.equal(legs.usdc.claim(payer(i), GRANT, T0), null, `grant ${i + 1} of 5 should fit`);
  }
  assert.equal(legs.usdc.claim(payer(99), GRANT, T0)?.kind, "budget");
});

test("neither leg's spent ceiling can close the other's door", () => {
  // Fails if the two BudgetStates are ever collapsed into one counter, in
  // either direction — and the two directions catch different collapses. A
  // single state metered by the USDC ceiling kills the gas leg on its first
  // call; a single state metered per-leg still lets 0.01 ETH of `spent` swamp
  // a 20,000,000-unit USDC ceiling.
  const spentGas = createFaucetLegs(false);
  for (let i = 0; i < 5; i++) spentGas.gas.claim(payer(i), ETH_TARGET, T0);
  assert.equal(spentGas.gas.claim(payer(99), ETH_TARGET, T0)?.kind, "budget");
  assert.equal(
    spentGas.usdc.claim(A, GRANT, T0),
    null,
    "a spent gas ceiling must not stop a USDC grant",
  );

  const spentUsdc = createFaucetLegs(false);
  for (let i = 0; i < 5; i++) spentUsdc.usdc.claim(payer(i), GRANT, T0);
  assert.equal(spentUsdc.usdc.claim(payer(99), GRANT, T0)?.kind, "budget");
  assert.equal(
    spentUsdc.gas.claim(A, ETH_TARGET, T0),
    null,
    "a spent USDC ceiling must not stop a gas top-up — a payer holding plenty of " +
      "USDC and no gas could otherwise never configure an agent",
  );
});

test("neither leg's cooldown can refuse the other — the stage failure", () => {
  // The presenter pays S$1.50, which arms the USDC cooldown. Thirty seconds
  // later they tap Revoke, which needs gas. Sharing one `lastFunded` map is what
  // used to answer that with a 429 about USDC while the ETH ceiling sat untouched.
  const legs = createFaucetLegs(true); // demo host: unmetered, so only cooldowns can refuse
  legs.usdc.armCooldown(A, T0);
  legs.usdc.finish(A);

  const thirtySecondsLater = T0 + 30_000;
  assert.equal(legs.usdc.claim(A, GRANT, thirtySecondsLater)?.kind, "cooldown");
  assert.equal(
    legs.gas.claim(A, ETH_TARGET, thirtySecondsLater),
    null,
    "the gas leg must not read the USDC leg's cooldown",
  );

  // And the reverse, for the payer who tops up gas and then wants to pay.
  const other = createFaucetLegs(true);
  other.gas.armCooldown(B, T0);
  other.gas.finish(B);
  assert.equal(other.gas.claim(B, ETH_TARGET, thirtySecondsLater)?.kind, "cooldown");
  assert.equal(other.usdc.claim(B, GRANT, thirtySecondsLater), null);
});

test("in-flight is per leg and per address, and clears on finish", () => {
  const legs = createFaucetLegs(true);
  assert.equal(legs.usdc.claim(A, GRANT, T0), null);
  assert.deepEqual(legs.usdc.claim(A, GRANT, T0), { kind: "in_flight" }, "concurrent grants to one address");
  assert.equal(legs.usdc.claim(B, GRANT, T0), null, "a different payer is unaffected");
  assert.equal(legs.gas.claim(A, ETH_TARGET, T0), null, "the gas leg has its own in-flight set");

  legs.usdc.finish(A);
  assert.equal(legs.usdc.claim(A, GRANT, T0), null, "finish releases the key");
});

test("finish releases by key alone, so only the claim's owner may call it", () => {
  // This is a contract note, not a nicety. `finish` cannot tell who put the key
  // there, so a caller that reaches its `finally` WITHOUT having claimed will
  // clear whoever did. That is exactly what the gas leg did: an already-funded
  // address returned early, and a second request refused as `in_flight` threw —
  // both ran the same unconditional `finish`, freeing the marker of the request
  // that was mid-transfer. A third then claimed and sent a second top-up before
  // the first armed its cooldown, repeatably, against the only gas key there is.
  const legs = createFaucetLegs(true);
  assert.equal(legs.gas.claim(A, ETH_TARGET, T0), null, "the sender claims");
  assert.deepEqual(
    legs.gas.claim(A, ETH_TARGET, T0),
    { kind: "in_flight" },
    "a concurrent request is refused",
  );

  // What the refused request must NOT do.
  legs.gas.finish(A);
  assert.equal(
    legs.gas.claim(A, ETH_TARGET, T0),
    null,
    "a non-owner's finish frees the key — which is why topUpGas guards its finally on having claimed",
  );
});

// ------------------------------------------------------ reservation lifecycle

test("a claim reserves before the spend, so concurrent callers cannot overshoot", () => {
  // Four payers claim; the ceiling is spent before any transfer confirms.
  const leg = createFaucetLeg(GRANT * 4n, USDC_COOLDOWN_MS);
  for (let i = 0; i < 4; i++) assert.equal(leg.claim(payer(i), GRANT, T0), null);
  assert.equal(leg.claim(payer(4), GRANT, T0)?.kind, "budget");
});

test("a definite failure returns its reservation; an ambiguous one keeps it", () => {
  const leg = createFaucetLeg(GRANT, USDC_COOLDOWN_MS);
  assert.equal(leg.claim(A, GRANT, T0), null);
  leg.finish(A);
  assert.equal(leg.claim(B, GRANT, T0)?.kind, "budget", "the ceiling is one grant");

  // Proven-dead spend: the allowance comes back and the next payer fits.
  leg.release(GRANT);
  assert.equal(leg.claim(B, GRANT, T0), null);
  leg.finish(B);

  // Ambiguous = no release call at all, so the ceiling stays charged.
  // Over-counting costs one grant; under-counting hands out funds nothing
  // accounted for.
  assert.equal(leg.claim(payer(7), GRANT, T0)?.kind, "budget");
});

test("a refusal never restarts the 24h countdown", () => {
  // Committing the rolled state on a refusal would advertise a fresh day every
  // time someone is turned away, forever, for a condition that never improves.
  const leg = createFaucetLeg(GRANT, USDC_COOLDOWN_MS);
  assert.equal(leg.claim(A, GRANT, T0), null);

  const halfway = T0 + BUDGET_WINDOW_MS / 2;
  const refused = { kind: "budget", remaining: 0n, resetInMs: BUDGET_WINDOW_MS / 2 };
  assert.deepEqual(leg.claim(B, GRANT, halfway), refused);
  // Asking again must not have moved it.
  assert.deepEqual(leg.claim(B, GRANT, halfway), refused);

  // Past the window it rolls for real.
  assert.equal(leg.claim(B, GRANT, T0 + BUDGET_WINDOW_MS), null);
});

test("a cooldown refuses until its interval has fully elapsed, then allows", () => {
  // The boundary only: `<` vs `<=` on each leg. It deliberately does NOT claim
  // to prove each leg read its OWN constant — USDC_COOLDOWN_MS and
  // GAS_COOLDOWN_MS are both 60s, so collapsing them into one shared value
  // would pass this identically. What each leg keeps to itself is proven by the
  // separate cooldown-, in-flight- and ceiling-independence tests above, which
  // exercise the two legs against each other rather than against a number.
  const legs = createFaucetLegs(true);
  legs.usdc.armCooldown(A, T0);
  legs.usdc.finish(A);
  assert.equal(legs.usdc.claim(A, GRANT, T0 + USDC_COOLDOWN_MS - 1)?.kind, "cooldown");
  assert.equal(legs.usdc.claim(A, GRANT, T0 + USDC_COOLDOWN_MS), null);

  legs.gas.armCooldown(B, T0);
  legs.gas.finish(B);
  assert.equal(legs.gas.claim(B, ETH_TARGET, T0 + GAS_COOLDOWN_MS - 1)?.kind, "cooldown");
  assert.equal(legs.gas.claim(B, ETH_TARGET, T0 + GAS_COOLDOWN_MS), null);
});

test("an unmetered demo host refuses nothing on either ceiling", () => {
  const legs = createFaucetLegs(true);
  // Ten rehearsal passes' worth, which any sane public ceiling would refuse.
  for (let i = 0; i < 20; i++) {
    assert.equal(legs.usdc.claim(payer(i), GRANT, T0), null);
    assert.equal(legs.gas.claim(payer(i), ETH_TARGET, T0), null);
  }
});
