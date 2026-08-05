import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { BaseError } from "viem";
import {
  decodeGantryError,
  describeGantryError,
  serializeArgs,
  type ApiErrorBody,
} from "@gantry/shared";

export class ApiError extends Error {
  readonly status: number;
  readonly errorName: string;
  readonly args?: unknown;

  constructor(status: number, errorName: string, message: string, args?: unknown) {
    super(message);
    this.status = status;
    this.errorName = errorName;
    this.args = args;
  }
}

/** HTTP status for a decoded contract error — conflict-shaped errors get 409. */
function statusForContractError(name: string): number {
  switch (name) {
    case "UnknownIntent":
    case "MerchantNotFound":
      return 404;
    case "IntentAlreadySettled":
    case "IntentWasCancelled":
    case "IntentExpired":
    case "AuthorizationAlreadyUsed":
      return 409;
    default:
      return 400;
  }
}

export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    const body: ApiErrorBody = {
      error: { name: err.errorName, args: serializeArgs(err.args), message: err.message },
    };
    res.status(err.status).json(body);
    return;
  }
  if (err instanceof ZodError) {
    const body: ApiErrorBody = {
      error: {
        name: "ValidationError",
        args: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        message: "invalid request body",
      },
    };
    res.status(400).json(body);
    return;
  }
  if (err instanceof BaseError) {
    const decoded = decodeGantryError(err);
    const message = describeGantryError(decoded);
    if (decoded.kind === "custom") {
      const body: ApiErrorBody = {
        error: { name: decoded.name, args: serializeArgs(decoded.args), message },
      };
      res.status(statusForContractError(decoded.name)).json(body);
      return;
    }
    if (decoded.kind === "string") {
      // Real Circle USDC reverts with strings ("FiatTokenV2: …").
      const status = decoded.reason.includes("used or canceled") ? 409 : 400;
      const body: ApiErrorBody = { error: { name: "StringRevert", message: decoded.reason } };
      res.status(status).json(body);
      return;
    }
  }
  console.error("unhandled error:", err);
  const body: ApiErrorBody = {
    error: { name: "InternalError", message: err instanceof Error ? err.message : String(err) },
  };
  res.status(500).json(body);
}
