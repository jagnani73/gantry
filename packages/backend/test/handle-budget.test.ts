import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyHandleBudgets,
  releaseForHandle,
  reserveForHandle,
} from "../src/services/handle-budget";

const LIMIT = 10n;
const WINDOW = 86_400_000;
const T0 = 1_000_000_000_000;

test("a key spends its own share and no more", () => {
  const budgets = emptyHandleBudgets();
  for (let i = 0; i < 10; i++) {
    assert.equal(reserveForHandle(budgets, "ah-hock", LIMIT, T0 + i, WINDOW).ok, true, `take ${i}`);
  }
  assert.equal(reserveForHandle(budgets, "ah-hock", LIMIT, T0 + 10, WINDOW).ok, false);
});

test("one key's exhaustion leaves every other key untouched", () => {
  // The whole point of this module. A shared ceiling alone is spent wherever an
  // attacker points it, so draining one shop must not refuse the next.
  const budgets = emptyHandleBudgets();
  for (let i = 0; i < 10; i++) reserveForHandle(budgets, "victim", LIMIT, T0 + i, WINDOW);
  assert.equal(reserveForHandle(budgets, "victim", LIMIT, T0 + 11, WINDOW).ok, false);
  assert.equal(reserveForHandle(budgets, "someone-else", LIMIT, T0 + 12, WINDOW).ok, true);
});

test("a refused attempt does not consume the share", () => {
  const budgets = emptyHandleBudgets();
  for (let i = 0; i < 10; i++) reserveForHandle(budgets, "shop", LIMIT, T0 + i, WINDOW);
  // Three refusals, then the window rolls: the shop must get its full share
  // back, not a share reduced by attempts that were never granted.
  for (let i = 0; i < 3; i++) reserveForHandle(budgets, "shop", LIMIT, T0 + 20 + i, WINDOW);
  const rolled = T0 + WINDOW + 1;
  for (let i = 0; i < 10; i++) {
    assert.equal(reserveForHandle(budgets, "shop", LIMIT, rolled + i, WINDOW).ok, true, `take ${i}`);
  }
});

test("release returns a unit so a failed write cannot ratchet a shop shut", () => {
  const budgets = emptyHandleBudgets();
  for (let i = 0; i < 10; i++) {
    reserveForHandle(budgets, "shop", LIMIT, T0 + i, WINDOW);
    releaseForHandle(budgets, "shop");
  }
  // Ten reserve/release pairs spent nothing, so the eleventh still has room —
  // without this the owner's own corrections would close their shop's window.
  assert.equal(reserveForHandle(budgets, "shop", LIMIT, T0 + 50, WINDOW).ok, true);
});

test("release on a key that was never reserved is a no-op, not a credit", () => {
  const budgets = emptyHandleBudgets();
  releaseForHandle(budgets, "ghost");
  assert.equal(budgets.has("ghost"), false);
  for (let i = 0; i < 10; i++) reserveForHandle(budgets, "ghost", LIMIT, T0 + i, WINDOW);
  assert.equal(reserveForHandle(budgets, "ghost", LIMIT, T0 + 11, WINDOW).ok, false);
});

test("the window rolls per key, from that key's first reservation", () => {
  const budgets = emptyHandleBudgets();
  for (let i = 0; i < 10; i++) reserveForHandle(budgets, "early", LIMIT, T0 + i, WINDOW);
  // A key that started later is still inside its own window when the first one
  // has rolled — deliberately not calendar days, which would hand everyone a
  // fresh budget at the same instant.
  const late = T0 + WINDOW / 2;
  for (let i = 0; i < 10; i++) reserveForHandle(budgets, "late", LIMIT, late + i, WINDOW);

  const afterFirst = T0 + WINDOW + 1;
  assert.equal(reserveForHandle(budgets, "early", LIMIT, afterFirst, WINDOW).ok, true);
  assert.equal(reserveForHandle(budgets, "late", LIMIT, afterFirst, WINDOW).ok, false);
});

test("keys are swept once their window has rolled", () => {
  const budgets = emptyHandleBudgets();
  for (const handle of ["a", "b", "c"]) reserveForHandle(budgets, handle, LIMIT, T0, WINDOW);
  assert.equal(budgets.size, 3);
  // The sweep runs on the next reservation, whatever key it is for: the map is
  // keyed by handle and the route is open, so the key space is unbounded.
  reserveForHandle(budgets, "d", LIMIT, T0 + WINDOW + 1, WINDOW);
  assert.deepEqual([...budgets.keys()], ["d"]);
});

test("resetInMs counts down within a window and restarts after it rolls", () => {
  const budgets = emptyHandleBudgets();
  const first = reserveForHandle(budgets, "shop", LIMIT, T0, WINDOW);
  assert.equal(first.resetInMs, WINDOW);
  const later = reserveForHandle(budgets, "shop", LIMIT, T0 + 1_000, WINDOW);
  assert.equal(later.resetInMs, WINDOW - 1_000);
  const rolled = reserveForHandle(budgets, "shop", LIMIT, T0 + WINDOW + 5, WINDOW);
  assert.equal(rolled.resetInMs, WINDOW);
});
