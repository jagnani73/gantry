import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIMENSION_ERROR,
  POLICY_DIMENSIONS,
  VOLATILE_DIMENSIONS,
  auditDenial,
  checkSpend,
  unprovableBecause,
  type PolicyState,
} from "./policyCheck";

const NOW = 1_787_000_000;

/** The demo wallet: S$50/day at the demo rate, food_beverage only (bit 1). */
const armed: PolicyState = {
  expiry: NOW + 30 * 86_400,
  categoryBitmap: 1n << 1n,
  perTxCap: 37_255_049n,
  dailyCap: 37_255_049n,
  spentToday: 0n,
  balance: 10_000_000n,
};

const iceTea = { categoryId: 1, amount: 3_352_955n, atUnixSeconds: NOW };

test("the demo beat: three iced teas from a food merchant are allowed", () => {
  const verdict = checkSpend(armed, iceTea);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.refusedBy, null);
  assert.equal(verdict.errorName, null);
  assert.ok(verdict.checks.every((c) => c.ok));
});

test("the rejection beat: a phone cable is refused for its CATEGORY, not its price", () => {
  // electronics = categoryId 2, and the whole point of pricing it at S$4 is that
  // every cap admits it — so if this ever reports perTx or daily, the beat has
  // silently become a different story.
  const verdict = checkSpend(armed, { categoryId: 2, amount: 2_980_404n, atUnixSeconds: NOW });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.refusedBy, "category");
  assert.equal(verdict.errorName, "CategoryNotAllowed");
  assert.equal(verdict.checks.find((c) => c.dimension === "perTx")?.ok, true, "the amount was fine");
  assert.equal(verdict.checks.find((c) => c.dimension === "daily")?.ok, true);
});

test("the first failure in CONTRACT order is the one reported", () => {
  // Expired AND out-of-category AND over every cap. authorizeSpend checks expiry
  // first and reverts there, so anything else would name a reason the chain
  // never gave.
  const verdict = checkSpend(
    { ...armed, expiry: NOW - 1 },
    { categoryId: 7, amount: 999_999_999n, atUnixSeconds: NOW },
  );
  assert.equal(verdict.refusedBy, "expiry");
  assert.equal(verdict.errorName, "PolicyExpired");
  // The balance fails too — 999999999 is more than the wallet holds — so all
  // five report, and only the first decides. That is the property: the other
  // four stay visible for a reader, and none of them can change the verdict.
  assert.equal(verdict.checks.filter((c) => !c.ok).length, 5, "the rest still evaluate");
});

test("checks are always returned in the contract's order", () => {
  assert.deepEqual(
    checkSpend(armed, iceTea).checks.map((c) => c.dimension),
    [...POLICY_DIMENSIONS],
  );
});

test("expiry is the LAST second a spend is allowed", () => {
  // Pinned to authorizeSpend, which reverts on `block.timestamp > expiry`.
  const atExpiry = checkSpend({ ...armed, expiry: NOW }, iceTea);
  assert.equal(atExpiry.allowed, true, "now === expiry is still active");
  assert.equal(checkSpend({ ...armed, expiry: NOW - 1 }, iceTea).refusedBy, "expiry");
});

test("a revoked policy is expiry 0, and refuses before anything else", () => {
  const verdict = checkSpend(
    { ...armed, expiry: 0, categoryBitmap: 0n, perTxCap: 0n, dailyCap: 0n },
    iceTea,
  );
  assert.equal(verdict.refusedBy, "expiry");
  assert.match(verdict.checks[0]!.actual, /revoked/);
});

test("the daily cap counts what the day already spent", () => {
  const nearlySpent = { ...armed, spentToday: 35_000_000n };
  assert.equal(checkSpend(nearlySpent, iceTea).refusedBy, "daily");
  // Same wallet, same amount, fresh day — the contract buckets by UTC day and
  // reports spentToday() as 0, so nothing here needs to know about days.
  assert.equal(checkSpend({ ...nearlySpent, spentToday: 0n }, iceTea).allowed, true);
});

test("balance is checked last, so a poor wallet inside policy names the balance", () => {
  const verdict = checkSpend({ ...armed, balance: 1n }, iceTea);
  assert.equal(verdict.refusedBy, "balance");
  assert.equal(verdict.errorName, "InsufficientWalletBalance");
});

test("an out-of-range categoryId denies rather than exploding", () => {
  // Solidity shifts of 256+ yield 0, so the contract denies. JS would happily
  // compute 1n << 300n and match nothing — or worse, match something.
  for (const categoryId of [256, 300, 1e6]) {
    const verdict = checkSpend({ ...armed, categoryBitmap: ~0n }, { ...iceTea, categoryId });
    assert.equal(verdict.refusedBy, "category", `categoryId ${categoryId}`);
  }
});

test("every dimension has the contract's own error name", () => {
  assert.deepEqual(Object.keys(DIMENSION_ERROR).sort(), [...POLICY_DIMENSIONS].sort());
  assert.equal(DIMENSION_ERROR.category, "CategoryNotAllowed");
  assert.equal(DIMENSION_ERROR.perTx, "PerTxCapExceeded");
});

test("auditDenial confirms a refusal that public state agrees with", () => {
  const verdict = checkSpend(armed, { categoryId: 2, amount: 2_980_404n, atUnixSeconds: NOW });
  assert.equal(auditDenial("CategoryNotAllowed", verdict), "consistent");
});

test("auditDenial CONTRADICTS a fabricated refusal — the case that makes it worth having", () => {
  // A verifier that can only ever agree proves nothing. Claim the phone-cable
  // reason for a spend the policy plainly admits, and it must refuse to confirm.
  const allowed = checkSpend(armed, iceTea);
  assert.equal(auditDenial("CategoryNotAllowed", allowed), "contradicted");
  // And a claim naming the wrong dimension for a real refusal is also caught:
  // the amount was fine, so "PerTxCapExceeded" is not what the chain would say.
  const refused = checkSpend(armed, { categoryId: 2, amount: 2_980_404n, atUnixSeconds: NOW });
  assert.equal(auditDenial("PerTxCapExceeded", refused), "contradicted");
});

test("auditDenial calls a signature failure unprovable, never contradicted", () => {
  // The one reason public state cannot speak to. Reporting it as contradicted
  // would accuse the record of lying whenever the agent simply signed wrong.
  const allowed = checkSpend(armed, iceTea);
  assert.equal(auditDenial("InvalidAgentSignature", allowed), "unprovable");
  assert.equal(auditDenial("SomethingElseEntirely", allowed), "unprovable");
});

test("a dimension whose inputs have since moved is unprovable, not contradicted", () => {
  // The docstring promised this and the code did not deliver it: `unprovable`
  // was reachable ONLY for a claim outside DIMENSION_ERROR, so a real
  // DailyCapExceeded that no longer re-derives came back as `contradicted` —
  // our own verifier calling our own honest record a lie, and exiting 1.
  //
  // It is reachable without anybody misbehaving. A refusal has no reverted
  // transaction, so the record rides on the cancel, which lands in a LATER
  // block; `spentToday()` is bucketed by UTC day, so a boundary in that gap
  // reads it as zero and the spend recomputes as allowed.
  const rolledOver = checkSpend(armed, iceTea);
  assert.equal(rolledOver.allowed, true, "the day rolled, so nothing refuses it now");
  assert.equal(auditDenial("DailyCapExceeded", rolledOver), "unprovable");
  // Same for a balance, which anyone may change and demo-reset routinely does.
  assert.equal(auditDenial("InsufficientWalletBalance", rolledOver), "unprovable");
});

test("the volatile carve-out is narrow — a fabricated stable claim is still caught", () => {
  // The carve-out must not become a way for any wrong record to escape. The
  // three dimensions that cannot move between the decision and the cancel
  // (expiry, category, perTx) stay fully checkable.
  const allowed = checkSpend(armed, iceTea);
  assert.equal(auditDenial("CategoryNotAllowed", allowed), "contradicted");
  assert.equal(auditDenial("PerTxCapExceeded", allowed), "contradicted");
  assert.equal(auditDenial("PolicyExpired", allowed), "contradicted");
  assert.deepEqual([...VOLATILE_DIMENSIONS], ["daily", "balance"]);
});

test("an unprovable verdict can say WHY, in the caller's own output", () => {
  // The CLI prints this beside the verdict. A checker that answers "cannot say"
  // without saying what it could not read is indistinguishable from a broken one.
  assert.match(unprovableBecause("DailyCapExceeded"), /spentToday\(\).*UTC day/);
  assert.match(unprovableBecause("InsufficientWalletBalance"), /balance, which anyone can change/);
  assert.match(unprovableBecause("InvalidAgentSignature"), /not a policy dimension/);
});
