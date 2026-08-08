import { test } from "node:test";
import assert from "node:assert/strict";
import { UNIX_SECONDS_CEILING, assertUnixSeconds } from "./time";

test("passes real wire timestamps through unchanged", () => {
  assert.equal(assertUnixSeconds(1_786_000_000), 1_786_000_000);
  assert.equal(assertUnixSeconds(0), 0);
  assert.equal(assertUnixSeconds(UNIX_SECONDS_CEILING), UNIX_SECONDS_CEILING);
});

test("catches a millisecond clock", () => {
  assert.throws(() => assertUnixSeconds(Date.now(), "expiry"), /expiry looks like milliseconds/);
  assert.throws(() => assertUnixSeconds(UNIX_SECONDS_CEILING + 1), /milliseconds/);
});

test("rejects anything that is not an integer second", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => assertUnixSeconds(bad), /unix seconds/, `expected throw: ${bad}`);
  }
});
