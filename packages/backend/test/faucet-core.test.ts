import assert from "node:assert/strict";
import { test } from "node:test";
import { funderCanSend, gasTopUpAmount } from "../src/services/faucet-core";
import { emptyBudget, release, reserve } from "../src/services/faucet-budget";

const ETH_TARGET = 2_000_000_000_000_000n; // 0.002
const RESERVE = 50_000_000_000_000_000n; // 0.05
const ETH_BUDGET = 10_000_000_000_000_000n; // 0.01 — five full top-ups
const USDC_BUDGET = 20_000_000n;
const WINDOW = 86_400_000;
const T0 = 1_000_000_000_000;

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
  assert.equal(funderCanSend(RESERVE + ETH_TARGET, ETH_TARGET, RESERVE), true);
  assert.equal(funderCanSend(RESERVE + ETH_TARGET - 1n, ETH_TARGET, RESERVE), false);
  // Sitting exactly on the reserve means every top-up is refused — correct: the
  // gas key relaying is worth more than any one payer configuring an agent.
  assert.equal(funderCanSend(RESERVE, 1n, RESERVE), false);
  assert.equal(funderCanSend(0n, 0n, RESERVE), false);
});

test("the ETH ceiling is five full top-ups, matching the USDC leg's five grants", () => {
  let state = emptyBudget();
  for (let i = 0; i < 5; i++) {
    const r = reserve(state, ETH_TARGET, ETH_BUDGET, T0, WINDOW);
    assert.equal(r.ok, true, `top-up ${i + 1} of 5 should fit`);
    state = r.state;
  }
  const over = reserve(state, ETH_TARGET, ETH_BUDGET, T0, WINDOW);
  assert.equal(over.ok, false, "the sixth is refused");
  assert.equal(over.remaining, 0n);
});

test("exhausting one leg's ceiling leaves the other untouched", () => {
  // Two BudgetStates, never one counter: gas top-ups must not be able to close
  // the door on payments, and payments must not be able to close the door on
  // gas. They guard different assets against different failures.
  let ethState = emptyBudget();
  for (let i = 0; i < 5; i++) ethState = reserve(ethState, ETH_TARGET, ETH_BUDGET, T0, WINDOW).state;
  assert.equal(reserve(ethState, ETH_TARGET, ETH_BUDGET, T0, WINDOW).ok, false);

  const usdcState = emptyBudget();
  assert.equal(
    reserve(usdcState, 4_000_000n, USDC_BUDGET, T0, WINDOW).ok,
    true,
    "a spent ETH ceiling must not stop a USDC grant",
  );
});

test("a definite failure returns its reservation; an ambiguous one keeps it", () => {
  const after = reserve(emptyBudget(), ETH_TARGET, ETH_BUDGET, T0, WINDOW).state;
  assert.equal(release(after, ETH_TARGET).spent, 0n, "proven-dead sends give the allowance back");
  // Ambiguous = no release call at all, so the ceiling stays charged. Over-counting
  // costs one top-up; under-counting hands out ETH nothing accounted for.
  assert.equal(after.spent, ETH_TARGET);
});
