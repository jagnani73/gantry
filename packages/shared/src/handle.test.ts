import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidHandle } from "./handle";

test("valid handles", () => {
  for (const h of ["ah-hock-chicken-rice", "a", "a1", "a-b", "0-0", "a".repeat(32)]) {
    assert.ok(isValidHandle(h), `expected valid: ${h}`);
  }
});

test("invalid handles", () => {
  const cases = ["", "-a", "a-", "-", "A", "a_b", "a b", "a.b", "a".repeat(33), "café"];
  for (const h of cases) {
    assert.ok(!isValidHandle(h), `expected invalid: ${h}`);
  }
});
