import type { Address, Hex } from "viem";

/**
 * Vendored x402 v2 wire layer: owned types + the base64-JSON header codec.
 * Deliberately imports nothing from `@x402/*` — this is the churn insurance
 * CLAUDE.md mandates (the SDK is pinned, but the wire format is ours to hold
 * stable). v2 carries payment data in three headers, all base64-encoded JSON:
 * `PAYMENT-REQUIRED` on the 402, `PAYMENT-SIGNATURE` on the paid retry,
 * `PAYMENT-RESPONSE` on the final response. v1's `X-PAYMENT` is ignored.
 */

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

/** One accepts[] entry. v2 renamed v1's `maxAmountRequired` to `amount`. */
export interface X402PaymentRequirements {
  scheme: string;
  /** CAIP-2, e.g. "eip155:84532". */
  network: string;
  asset: Address;
  /** 6dp integer units as a decimal string. */
  amount: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  /** For `exact`/eip3009: the token's EIP-712 domain `{ name, version }`. */
  extra: Record<string, unknown>;
}

export interface X402ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

/** 402 challenge body carried in the PAYMENT-REQUIRED header. */
export interface X402PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: X402ResourceInfo;
  accepts: X402PaymentRequirements[];
}

/** `exact` scheme (eip3009 method) inner payload. */
export interface X402ExactEvmPayload {
  signature: Hex;
  authorization: {
    from: Address;
    to: Address;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
  };
}

/** Paid retry body carried in the PAYMENT-SIGNATURE header. The client echoes
 * the chosen accepts[] entry (`accepted`) and the challenge's `resource`. */
export interface X402PaymentPayload {
  x402Version: 2;
  resource?: X402ResourceInfo;
  accepted: X402PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface X402VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: Address;
}

export interface X402SettleResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: Address;
  /** Settlement tx hash; the spec requires the field even on failure (""). */
  transaction: string;
  network: string;
  amount?: string;
}

export interface X402SupportedResponse {
  kinds: { x402Version: number; scheme: string; network: string; extra?: Record<string, unknown> }[];
  extensions: string[];
  signers: Record<string, string[]>;
}

export function caip2(chainId: number): string {
  return `eip155:${chainId}`;
}

export function chainIdFromCaip2(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) throw new Error(`unsupported CAIP-2 network: ${network}`);
  return Number(match[1]);
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeBase64Json<T>(encoded: string): T {
  if (!BASE64_RE.test(encoded)) throw new Error("invalid base64 header value");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as T;
}

export const encodePaymentRequiredHeader = (v: X402PaymentRequired): string => encodeBase64Json(v);
export const decodePaymentRequiredHeader = (s: string): X402PaymentRequired =>
  decodeBase64Json<X402PaymentRequired>(s);
export const encodePaymentSignatureHeader = (v: X402PaymentPayload): string => encodeBase64Json(v);
export const decodePaymentSignatureHeader = (s: string): X402PaymentPayload =>
  decodeBase64Json<X402PaymentPayload>(s);
export const encodePaymentResponseHeader = (v: X402SettleResponse): string => encodeBase64Json(v);
export const decodePaymentResponseHeader = (s: string): X402SettleResponse =>
  decodeBase64Json<X402SettleResponse>(s);
