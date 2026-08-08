import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { MAX_PAYER_FILTER, matchesPayerFilter, parsePayerFilter } from "./payerFilter";

const HUMAN = "0x82513007C7eB93b54dC555Bdb74341b3084FC47B";
const WALLET = "0xDD4bbed78B64715288bf10fabB2b62c659299D3E";

test("absent filter means every payer", () => {
  for (const raw of [null, undefined]) {
    const result = parsePayerFilter(raw);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.payers, null);
  }
});

test("parses a list and lowercases it", () => {
  const result = parsePayerFilter(`${HUMAN},${WALLET}`);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.payers, [HUMAN.toLowerCase(), WALLET.toLowerCase()]);
});

test("tolerates spacing around entries", () => {
  const result = parsePayerFilter(`  ${HUMAN} , ${WALLET}  `);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.payers, [HUMAN.toLowerCase(), WALLET.toLowerCase()]);
});

test("dedupes case variants of the same address", () => {
  const result = parsePayerFilter(`${HUMAN},${HUMAN.toLowerCase()}`);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.payers, [HUMAN.toLowerCase()]);
});

test("a present-but-empty filter is refused, never guessed", () => {
  // Matching everything would leak strangers' rows into Your Activity; matching
  // nothing renders a healthy-looking empty feed. Neither is detectable on
  // stage, so this has to be an error.
  for (const raw of ["", "   ", ",", " , , "]) {
    const result = parsePayerFilter(raw);
    assert.equal(result.ok, false, `expected refusal: ${JSON.stringify(raw)}`);
    assert.equal(!result.ok && result.reason, "empty");
  }
});

test("rejects a non-address entry", () => {
  for (const bad of ["nope", "0x123", `${HUMAN}00`, HUMAN.slice(2)]) {
    const result = parsePayerFilter(`${WALLET},${bad}`);
    assert.equal(result.ok, false, `expected rejection: ${bad}`);
    assert.equal(!result.ok && result.reason, "malformed");
  }
});

test("accepts a bad EIP-55 checksum — a read filter cannot misroute anything", () => {
  // Deliberately unlike normalizePayout: casing is discarded a line later, and
  // the all-uppercase form some tools emit must not be rejected.
  const flipped = "0x82513007c7eB93b54dC555Bdb74341b3084FC47B";
  const upper = `0x${HUMAN.slice(2).toUpperCase()}`;
  for (const raw of [flipped, upper]) {
    const result = parsePayerFilter(raw);
    assert.equal(result.ok, true, `expected acceptance: ${raw}`);
    assert.deepEqual(result.ok && result.payers, [HUMAN.toLowerCase()]);
  }
});

test("caps the list length on the raw item count", () => {
  const result = parsePayerFilter(Array(MAX_PAYER_FILTER + 1).fill(HUMAN).join(","));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "too_many");
});

const row = (payer: string, agentPayer?: string) =>
  ({ payer: payer as Address, agentPayer: agentPayer as Address | undefined });

test("a null filter matches every row", () => {
  assert.equal(matchesPayerFilter(row(WALLET), null), true);
});

test("matches on payer or agentPayer", () => {
  const mine = [HUMAN.toLowerCase() as Address];
  // Human door: the payer signed it themselves.
  assert.equal(matchesPayerFilter(row(HUMAN), mine), true);
  // Bridged x402: on-chain payer is the relayer, the human is the agentPayer —
  // the row the agents screen exists to show.
  assert.equal(matchesPayerFilter(row(WALLET, HUMAN), mine), true);
  // Someone else's payment.
  assert.equal(matchesPayerFilter(row(WALLET), mine), false);
});

test("row matching is case-insensitive on both sides", () => {
  assert.equal(matchesPayerFilter(row(HUMAN), [HUMAN as Address]), true);
  assert.equal(matchesPayerFilter(row(HUMAN.toLowerCase()), [HUMAN as Address]), true);
});

test("a null agentPayer never matches a null-ish needle", () => {
  // Guards the shape of the OR: `undefined === undefined` would make every
  // PBM-less row match a filter that somehow carried an empty entry.
  assert.equal(matchesPayerFilter(row(WALLET, undefined), [HUMAN.toLowerCase() as Address]), false);
  assert.equal(matchesPayerFilter({ payer: WALLET as Address, agentPayer: null }, [HUMAN.toLowerCase() as Address]), false);
});
