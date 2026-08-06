import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Hex } from "viem";
import { gantryCoreAbi } from "./abis/gantryCore";
import { fixedRateSwapAbi } from "./abis/fixedRateSwap";
import { eip3009ErrorsAbi } from "./abis/eip3009Errors";

/**
 * Union of every custom error Gantry settlement can surface (core + swap +
 * mock tokens). M3: spread the AgentPBMWallet errors ABI here — otherwise
 * CategoryNotAllowed, DailyCapExceeded & co decode as "unknown" and the
 * on-stage rejection beat degrades to a raw 500.
 */
export const gantryErrorsAbi = [
  ...gantryCoreAbi.filter((entry) => entry.type === "error"),
  ...fixedRateSwapAbi.filter((entry) => entry.type === "error"),
  ...eip3009ErrorsAbi,
] as const;

/** Every error name in the union — compile-time safety for switches over decoded names. */
export type GantryErrorName = Extract<(typeof gantryErrorsAbi)[number], { type: "error" }>["name"];

export type DecodedGantryError =
  | { kind: "custom"; name: GantryErrorName | (string & {}); args: readonly unknown[] }
  /** Real Circle USDC reverts with strings, e.g. "FiatTokenV2: authorization is used or canceled". */
  | { kind: "string"; reason: string }
  | { kind: "unknown"; message: string };

/**
 * Revert shapes that can mean "a lagging RPC replica hasn't seen recent state"
 * rather than a real failure: a just-created intent decodes as UnknownIntent,
 * a just-minted balance as insufficient. Callers retry these, bounded.
 */
export function isStaleStateRevert(decoded: DecodedGantryError): boolean {
  if (decoded.kind === "custom") {
    return decoded.name === "UnknownIntent" || decoded.name === "ERC20InsufficientBalance";
  }
  return decoded.kind === "string" && /transfer amount exceeds balance/i.test(decoded.reason);
}

/**
 * Structural revert decoding — M2's facilitator maps this straight onto x402
 * invalidReason; M3's dashboard renders CategoryNotAllowed & co from it.
 */
export function decodeGantryError(err: unknown): DecodedGantryError {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      if (revert.data?.errorName) {
        // viem decodes the built-in Error(string) selector to errorName
        // "Error" — that is a string revert (real USDC's FiatTokenV2 shape),
        // not a custom error. Misclassifying it as custom broke both the
        // stale-state retry and the Circle reason mappings downstream.
        if (revert.data.errorName === "Error") {
          return { kind: "string", reason: String(revert.data.args?.[0] ?? revert.reason ?? "") };
        }
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
    // decodeErrorResult handles the standard Error(string)/Panic(uint256)
    // selectors itself, regardless of the ABI passed (so its name type,
    // derived from our ABI, is narrower than what can actually come back).
    const decoded = decodeErrorResult({ abi: gantryErrorsAbi, data });
    const errorName: string = decoded.errorName;
    const args = (decoded.args ?? []) as readonly unknown[];
    if (errorName === "Error") {
      return { kind: "string", reason: String(args[0] ?? "") };
    }
    return { kind: "custom", name: errorName, args };
  } catch {
    return null;
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
