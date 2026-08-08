import { test } from "node:test";
import assert from "node:assert/strict";
import { agentStatus } from "./agentStatus";

const NOW = 1_786_000_000; // some unix second in 2026

test("expiry 0 is revoked — armed policies never have it", () => {
  assert.equal(agentStatus({ expiry: 0, revoked: true }, NOW), "revoked");
  // The flag is derived from expiry, so a response missing it changes nothing.
  assert.equal(agentStatus({ expiry: 0 }, NOW), "revoked");
});

test("a policy that merely ran out is lapsed, not active", () => {
  // The bug this helper exists to kill: `revoked` is false here, so a badge
  // rendered from it alone says Active while every spend reverts PolicyExpired.
  assert.equal(agentStatus({ expiry: NOW - 1, revoked: false }, NOW), "lapsed");
});

test("the boundary matches the contract: block.timestamp > expiry denies", () => {
  // AgentPBMWallet.authorizeSpend reverts only when now is PAST expiry, so the
  // expiry second itself is still spendable.
  assert.equal(agentStatus({ expiry: NOW, revoked: false }, NOW), "active");
  assert.equal(agentStatus({ expiry: NOW + 1, revoked: false }, NOW), "active");
  assert.equal(agentStatus({ expiry: NOW - 1, revoked: false }, NOW), "lapsed");
});

test("revoked wins over an expiry still in the future", () => {
  // Should not happen — revoke() zeroes expiry — but if a caller sets the flag
  // optimistically after sending revoke(), believe the flag rather than the
  // stale read it was rendered next to.
  assert.equal(agentStatus({ expiry: NOW + 86_400, revoked: true }, NOW), "revoked");
});

test("an unreadable expiry is revoked, never active", () => {
  // A failed chain read must not render as an armed policy.
  for (const expiry of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.equal(agentStatus({ expiry, revoked: false }, NOW), "revoked", `expiry ${expiry}`);
  }
});

test("a millisecond clock is refused rather than calling everything active", () => {
  assert.throws(() => agentStatus({ expiry: NOW, revoked: false }, Date.now()), /milliseconds/);
  assert.throws(() => agentStatus({ expiry: NOW, revoked: false }, Number.NaN), /unix seconds/);
});
