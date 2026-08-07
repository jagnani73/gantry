import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePayout } from "./payout";

// The demo relayer/deployer address, in its EIP-55 form.
const CHECKSUMMED = "0x82513007C7eB93b54dC555Bdb74341b3084FC47B";

test("accepts a correctly checksummed address", () => {
  const result = normalizePayout(CHECKSUMMED);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.address, CHECKSUMMED);
});

test("accepts all-lowercase and normalizes to checksummed", () => {
  // Nothing to verify in an all-lowercase address, so it's accepted — a
  // merchant hand-typing one must not be blocked.
  const result = normalizePayout(CHECKSUMMED.toLowerCase());
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.address, CHECKSUMMED);
});

test("trims surrounding whitespace from a paste", () => {
  const result = normalizePayout(`  ${CHECKSUMMED}\n`);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.address, CHECKSUMMED);
});

test("rejects mixed-case that fails EIP-55", () => {
  // One character's case flipped (index 10, C→c) — the exact corruption a bare
  // hex regex misses, and which would permanently misroute this merchant's
  // payments since setMerchantPayout is gated on the payout address itself.
  const corrupted = "0x82513007c7eB93b54dC555Bdb74341b3084FC47B";
  const result = normalizePayout(corrupted);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "bad_checksum");
});

test("rejects the all-uppercase form", () => {
  // viem cannot verify it, so we ask for lowercase rather than accept an
  // address whose checksum carries no information.
  const result = normalizePayout(`0x${CHECKSUMMED.slice(2).toUpperCase()}`);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "bad_checksum");
});

test("rejects the zero address", () => {
  const result = normalizePayout(`0x${"0".repeat(40)}`);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "zero_address");
});

test("rejects malformed input", () => {
  for (const bad of ["", "nope", "0x123", CHECKSUMMED.slice(0, -1), `${CHECKSUMMED}00`, "82513007C7eB93b54dC555Bdb74341b3084FC47B"]) {
    const result = normalizePayout(bad);
    assert.equal(result.ok, false, `expected rejection: ${bad}`);
    assert.equal(!result.ok && result.reason, "malformed");
  }
});
