import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeErrorResult } from "viem";
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
