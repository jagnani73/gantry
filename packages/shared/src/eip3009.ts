import type { Address, Hex } from "viem";

/** EIP-3009 TransferWithAuthorization EIP-712 types (FiatToken-shaped). */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface Eip712TokenDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

export interface TransferAuthorizationParams {
  domain: Eip712TokenDomain;
  /** The payer. */
  from: Address;
  /** Always the GantryCore address — funds are pulled into the core. */
  to: Address;
  /** Exactly intent.amountIn. */
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  /** Always the intentId — binds the signature to the intent. */
  nonce: Hex;
}

/** Ready for viem signTypedData / wagmi useSignTypedData. */
export function buildTransferAuthorization(params: TransferAuthorizationParams) {
  return {
    domain: params.domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: params.from,
      to: params.to,
      value: params.value,
      validAfter: params.validAfter,
      validBefore: params.validBefore,
      nonce: params.nonce,
    },
  } as const;
}

/**
 * JSON-safe form: every uint256 crosses HTTP as a decimal string.
 * `from` is absent when the backend mints the quote (payer unknown at intent
 * creation) — the client supplies it when reviving.
 */
export interface WireTypedData {
  domain: Eip712TokenDomain;
  primaryType: "TransferWithAuthorization";
  message: {
    from?: Address;
    to: Address;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
  };
}

export function toWireTypedData(
  params: Omit<TransferAuthorizationParams, "from"> & { from?: Address },
): WireTypedData {
  return {
    domain: params.domain,
    primaryType: "TransferWithAuthorization",
    message: {
      ...(params.from ? { from: params.from } : {}),
      to: params.to,
      value: params.value.toString(),
      validAfter: params.validAfter.toString(),
      validBefore: params.validBefore.toString(),
      nonce: params.nonce,
    },
  };
}

/** The single string→bigint boundary on the client. `from` = the signing payer. */
export function reviveTypedData(wire: WireTypedData, from?: Address) {
  const payer = from ?? wire.message.from;
  if (!payer) throw new Error("reviveTypedData: payer address required (wire has no `from`)");
  return buildTransferAuthorization({
    domain: wire.domain,
    from: payer,
    to: wire.message.to,
    value: BigInt(wire.message.value),
    validAfter: BigInt(wire.message.validAfter),
    validBefore: BigInt(wire.message.validBefore),
    nonce: wire.message.nonce,
  });
}
