import { test } from "node:test";
import assert from "node:assert/strict";
import { ContractFunctionRevertedError, encodeErrorResult } from "viem";
import {
  decodeGantryError,
  decodeRawError,
  gantryErrorsAbi,
  isStaleStateRevert,
  serializeArgs,
  type DecodedGantryError,
} from "./errors";

const intentId = `0x${"11".repeat(32)}` as const;
const payer = "0x82513007C7eB93b54dC555Bdb74341b3084FC47B" as const;

test("decodes core custom errors from raw revert data", () => {
  const data = encodeErrorResult({
    abi: gantryErrorsAbi,
    errorName: "UnknownIntent",
    args: [intentId],
  });
  assert.deepEqual(decodeRawError(data), {
    kind: "custom",
    name: "UnknownIntent",
    args: [intentId],
  });
});

test("token errors inherited into the mock ABI stay in the union", () => {
  // Guards the ABI-regeneration path: if gen-abis drops the inherited OZ
  // errors, the stale-state retry stops firing.
  const data = encodeErrorResult({
    abi: gantryErrorsAbi,
    errorName: "ERC20InsufficientBalance",
    args: [payer, 0n, 4_843_157n],
  });
  const decoded = decodeRawError(data);
  assert.equal(decoded?.kind, "custom");
  assert.equal(decoded?.kind === "custom" && decoded.name, "ERC20InsufficientBalance");
});

test("standard Error(string) decodes as a string revert (real Circle USDC shape)", () => {
  const reason = "FiatTokenV2: authorization is used or canceled";
  const data = encodeErrorResult({
    abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
    errorName: "Error",
    args: [reason],
  });
  assert.deepEqual(decodeRawError(data), { kind: "string", reason });
});

test("live viem revert with errorName 'Error' is a string revert, not custom", () => {
  // Regression from the first live real-USDC settle: viem populates
  // data.errorName = "Error" for Error(string) reverts, and the custom branch
  // used to win — killing the stale-state retry and the Circle mappings.
  const reason = "ERC20: transfer amount exceeds balance";
  const data = encodeErrorResult({
    abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
    errorName: "Error",
    args: [reason],
  });
  const err = new ContractFunctionRevertedError({
    abi: gantryErrorsAbi,
    data,
    functionName: "settleWithAuthorization",
  });
  const decoded = decodeGantryError(err);
  assert.deepEqual(decoded, { kind: "string", reason });
  assert.ok(isStaleStateRevert(decoded), "replica-lag retry must fire for this shape");
});

test("agent pbm wallet policy errors decode from raw revert data", () => {
  // The rejection beat's decode path: settleFromPBM is simulated against
  // gantryCoreAbi, so wallet reverts arrive as raw bytes and only decode via
  // this union. If the AgentPBMWallet spread is dropped these become
  // "unknown" and the on-stage denial degrades to settlement_failed.
  const cases = [
    ["CategoryNotAllowed", [2]],
    ["PerTxCapExceeded", [21_607_928n, 10_000_000n]],
    ["DailyCapExceeded", [43_588_407n, 37_255_049n]],
    ["PolicyExpired", []],
    ["InsufficientWalletBalance", [1_000_000n, 4_843_157n]],
    ["InvalidAgentSignature", []],
  ] as const;
  for (const [errorName, args] of cases) {
    const data = encodeErrorResult({ abi: gantryErrorsAbi, errorName, args: args as never });
    assert.deepEqual(decodeRawError(data), { kind: "custom", name: errorName, args: [...args] });
  }
});

test("pbm wallet failure shapes must NOT trigger the stale-state retry", () => {
  const custom = (name: string, args: readonly unknown[] = []): DecodedGantryError => ({
    kind: "custom",
    name,
    args,
  });
  // PBMPullFailed superficially resembles a lag shape (short-received funds)
  // but is a legitimate permanent failure — blanket-retrying it would hammer
  // a silent wallet 5x for nothing. Same for the wallet's own balance error.
  assert.ok(!isStaleStateRevert(custom("PBMPullFailed", [0n, 4_843_157n])));
  assert.ok(!isStaleStateRevert(custom("InsufficientWalletBalance", [0n, 4_843_157n])));
  assert.ok(!isStaleStateRevert(custom("PolicyExpired")));
  assert.ok(!isStaleStateRevert(custom("DailyCapExceeded", [1n, 0n])));
});

test("garbage data returns null; non-viem errors decode as unknown", () => {
  assert.equal(decodeRawError("0xdeadbeef"), null);
  assert.deepEqual(decodeGantryError(new Error("boom")), { kind: "unknown", message: "boom" });
});

test("serializeArgs converts nested bigints for JSON bodies", () => {
  assert.deepEqual(serializeArgs([1n, { cap: 2n }, [3n]]), ["1", { cap: "2" }, ["3"]]);
});

test("stale-state retry predicate matches exactly the replica-lag shapes", () => {
  const custom = (name: string): DecodedGantryError => ({ kind: "custom", name, args: [] });
  assert.ok(isStaleStateRevert(custom("UnknownIntent")));
  assert.ok(isStaleStateRevert(custom("ERC20InsufficientBalance")));
  assert.ok(
    isStaleStateRevert({ kind: "string", reason: "ERC20: transfer amount exceeds balance" }),
  );
  assert.ok(!isStaleStateRevert(custom("IntentAlreadySettled")));
  assert.ok(!isStaleStateRevert(custom("AuthorizationAlreadyUsed")));
  assert.ok(!isStaleStateRevert(custom("CategoryNotAllowed"))); // M3 denial must NOT retry
  assert.ok(!isStaleStateRevert({ kind: "string", reason: "FiatTokenV2: invalid signature" }));
  assert.ok(!isStaleStateRevert({ kind: "unknown", message: "timeout" }));
});
