import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Hex } from "viem";
import { gantryCoreAbi } from "./abis/gantryCore";
import { fixedRateSwapAbi } from "./abis/fixedRateSwap";
import { eip3009ErrorsAbi } from "./abis/eip3009Errors";

/** Union of every custom error Gantry settlement can surface (core + swap + mock tokens). */
export const gantryErrorsAbi = [
  ...gantryCoreAbi.filter((entry) => entry.type === "error"),
  ...fixedRateSwapAbi.filter((entry) => entry.type === "error"),
  ...eip3009ErrorsAbi,
] as const;

export type DecodedGantryError =
  | { kind: "custom"; name: string; args: readonly unknown[] }
  /** Real Circle USDC reverts with strings, e.g. "FiatTokenV2: authorization is used or canceled". */
  | { kind: "string"; reason: string }
  | { kind: "unknown"; message: string };

/**
 * Structural revert decoding — M2's facilitator maps this straight onto x402
 * invalidReason; M3's dashboard renders CategoryNotAllowed & co from it.
 */
export function decodeGantryError(err: unknown): DecodedGantryError {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      if (revert.data?.errorName) {
        return { kind: "custom", name: revert.data.errorName, args: revert.data.args ?? [] };
      }
      if (revert.raw) {
        const fromRaw = decodeRawError(revert.raw);
        if (fromRaw) return fromRaw;
      }
      if (revert.reason) return { kind: "string", reason: revert.reason };
    }
    return { kind: "unknown", message: err.shortMessage };
  }
  return { kind: "unknown", message: err instanceof Error ? err.message : String(err) };
}

/** Decode bare revert data (0x…) against the Gantry error union. */
export function decodeRawError(data: Hex): DecodedGantryError | null {
  try {
    const decoded = decodeErrorResult({ abi: gantryErrorsAbi, data });
    return { kind: "custom", name: decoded.errorName, args: decoded.args ?? [] };
  } catch {
    // Not one of ours — try the standard Error(string) selector.
    try {
      const decoded = decodeErrorResult({
        abi: [
          {
            type: "error",
            name: "Error",
            inputs: [{ name: "message", type: "string" }],
          },
        ] as const,
        data,
      });
      return { kind: "string", reason: String(decoded.args[0]) };
    } catch {
      return null;
    }
  }
}

/** BigInt-safe serialization of decoded error args for JSON bodies. */
export function serializeArgs(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serializeArgs);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, serializeArgs(v)]),
    );
  }
  return value;
}

/** One-line human message for a decoded error (payer page + logs). */
export function describeGantryError(decoded: DecodedGantryError): string {
  switch (decoded.kind) {
    case "custom":
      return `${decoded.name}(${(decoded.args ?? []).map(String).join(", ")})`;
    case "string":
      return decoded.reason;
    case "unknown":
      return decoded.message;
  }
}
