import assert from "node:assert/strict";
import { test } from "node:test";
import { agentStatus } from "@gantry/shared";
import { decodeCategories, sameAddress, toAgentSummary, type RawAgentState } from "../src/services/agents-core";

const WALLET = "0xDD4bbed78B64715288bf10fabB2b62c659299D3E" as const;
const OWNER = "0x82513007C7eB93b54dC555Bdb74341b3084FC47B" as const;
const SIGNER = "0x0000000000000000000000000000000000000A11" as const;

/** food_beverage only — the canonical demo policy's bitmap. */
const FOOD = 1n << 1n;

function raw(over: Partial<RawAgentState> = {}): RawAgentState {
  return {
    wallet: WALLET,
    owner: OWNER,
    agentSigner: SIGNER,
    policy: [37_255_049n, 37_255_049n, 1_780_000_000, FOOD],
    spentToday: 3_352_955n,
    balance: 10_000_000n,
    token: "USDC",
    rate: 1_342_100n,
    ...over,
  };
}

test("every amount crosses the wire as a 6dp decimal string, never a number", () => {
  const summary = toAgentSummary(raw());
  for (const field of ["dailyCap", "perTxCap", "spentToday", "balance", "rate", "categoryBitmap"] as const) {
    assert.equal(typeof summary[field], "string", `${field} must be a string`);
  }
  assert.equal(summary.dailyCap, "37255049");
  assert.equal(summary.spentToday, "3352955");
  assert.equal(summary.rate, "1342100");
  // expiry is the one number: it is a unix second, not money.
  assert.equal(summary.expiry, 1_780_000_000);
});

test("a uint256 bitmap survives the round trip that JSON.stringify would not", () => {
  // Bit 255 set: outside anything Number can hold exactly, and the value a
  // bigint left un-stringified would throw on.
  const bitmap = (1n << 255n) | FOOD;
  const summary = toAgentSummary(raw({ policy: [1n, 1n, 1, bitmap] }));
  assert.equal(summary.categoryBitmap, bitmap.toString());
  assert.equal(BigInt(summary.categoryBitmap), bitmap);
});

test("categories decode by bit, and an unknown id renders rather than vanishing", () => {
  assert.deepEqual(decodeCategories(FOOD), ["food_beverage"]);
  assert.deepEqual(decodeCategories(FOOD | (1n << 2n)), ["food_beverage", "electronics"]);
  assert.deepEqual(decodeCategories(0n), []);
  // The owner allowed bit 7; the registry has no name for it. It must still be
  // visible — a silently dropped bit is a permission nobody can see or revoke.
  assert.deepEqual(decodeCategories(1n << 7n), ["category_7"]);
  // Bit 0 is a real bit: GantryCore's ids start at 1 by convention only.
  assert.deepEqual(decodeCategories(1n), ["category_0"]);
});

test("revoked is derived from expiry alone, and is not a status", () => {
  assert.equal(toAgentSummary(raw({ policy: [0n, 0n, 0, 0n] })).revoked, true);
  const lapsed = toAgentSummary(raw({ policy: [1n, 1n, 1_000, FOOD] }));
  assert.equal(lapsed.revoked, false, "a lapsed policy is not revoked");
  // …and this is exactly why a badge must not read `revoked`: the wallet denies
  // every spend here with PolicyExpired while the flag says otherwise.
  assert.equal(agentStatus(lapsed, 2_000), "lapsed");
  assert.equal(agentStatus(toAgentSummary(raw()), 1_700_000_000), "active");
  assert.equal(agentStatus(toAgentSummary(raw({ policy: [0n, 0n, 0, 0n] })), 1_700_000_000), "revoked");
});

test("expiry is the LAST allowed second, matching authorizeSpend", () => {
  const summary = toAgentSummary(raw({ policy: [1n, 1n, 5_000, FOOD] }));
  assert.equal(agentStatus(summary, 5_000), "active", "now === expiry still spends");
  assert.equal(agentStatus(summary, 5_001), "lapsed");
});

test("address comparison ignores case, because only chain reads are checksummed", () => {
  assert.equal(sameAddress(OWNER, OWNER.toLowerCase() as `0x${string}`), true);
  assert.equal(sameAddress(OWNER, WALLET), false);
});
