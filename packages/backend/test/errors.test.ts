import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, keccak256, toBytes } from "viem";
import { gantryCoreAbi, type ApiErrorBody } from "@gantry/shared";
import { ApiError, errorMiddleware } from "../src/errors";

/**
 * Pure-module tests (facilitator-core.test.ts precedent): errorMiddleware imports
 * only express types, zod, viem and @gantry/shared — no config, no chain.
 *
 * What this pins is the ERROR-NAME CONTRACT the onboarding UI branches on.
 * `/onboard` gates its entire Register button on the exact string
 * "MerchantNotFound" and its "pick another name" recovery on "HandleTaken";
 * if either stops matching, the button silently never enables or a routine
 * race becomes a red failure card mid-demo.
 */

interface Captured {
  status: number;
  body: ApiErrorBody;
}

function capture(err: unknown): Captured {
  const result = {} as Captured;
  const res = {
    status(code: number) {
      result.status = code;
      return this;
    },
    json(body: ApiErrorBody) {
      result.body = body;
      return this;
    },
  } as unknown as Response;
  const req = { method: "POST", originalUrl: "/api/merchants" } as Request;
  errorMiddleware(err, req, res, () => undefined);
  return result;
}

/** A viem error shaped exactly like a reverted simulateContract call. */
function contractRevert(merchantId: `0x${string}`): BaseError {
  const data = encodeErrorResult({
    abi: gantryCoreAbi,
    errorName: "HandleTaken",
    args: [merchantId],
  });
  const reverted = new ContractFunctionRevertedError({
    abi: gantryCoreAbi,
    data,
    functionName: "registerMerchant",
  });
  const outer = new BaseError("simulation failed");
  outer.cause = reverted;
  return outer;
}

test("ApiError round-trips its status, name and args", () => {
  const { status, body } = capture(
    new ApiError(400, "InvalidCategory", "unknown category: 9", [9]),
  );
  assert.equal(status, 400);
  assert.equal(body.error.name, "InvalidCategory");
  assert.equal(body.error.message, "unknown category: 9");
  assert.deepEqual(body.error.args, [9]);
});

test("MerchantNotFound keeps its 404 and its exact name", () => {
  // The availability check reads "available" from precisely this pairing.
  const { status, body } = capture(
    new ApiError(404, "MerchantNotFound", "no merchant registered for handle: kopi"),
  );
  assert.equal(status, 404);
  assert.equal(body.error.name, "MerchantNotFound");
});

test("a HandleTaken revert decodes to a 409 with that exact name", () => {
  const merchantId = keccak256(toBytes("ah-hock-chicken-rice"));
  const { status, body } = capture(contractRevert(merchantId));
  assert.equal(status, 409);
  assert.equal(body.error.name, "HandleTaken");
  // bigint-safe serialization keeps args JSON-able
  assert.deepEqual(body.error.args, [merchantId]);
});

test("a ZodError becomes a 400 ValidationError with field paths", () => {
  const err = new ZodError([
    { code: "custom", path: ["payout"], message: "expected 0x-prefixed address" },
  ]);
  const { status, body } = capture(err);
  assert.equal(status, 400);
  assert.equal(body.error.name, "ValidationError");
  assert.deepEqual(body.error.args, [{ path: "payout", message: "expected 0x-prefixed address" }]);
});

test("an undecodable error falls through to 500 InternalError", () => {
  // The receipt-timeout shape: a viem BaseError carrying no revert data.
  const { status, body } = capture(new BaseError("timed out waiting for receipt"));
  assert.equal(status, 500);
  assert.equal(body.error.name, "InternalError");
});

test("a plain Error also falls through to 500", () => {
  const { status, body } = capture(new Error("boom"));
  assert.equal(status, 500);
  assert.equal(body.error.name, "InternalError");
  assert.equal(body.error.message, "boom");
});
