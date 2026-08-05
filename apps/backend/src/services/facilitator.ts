import {
  caip2,
  eip3009TokenAbi,
  tokenIdByAddress,
  type X402PaymentPayload,
  type X402PaymentRequirements,
  type X402SupportedResponse,
  type X402VerifyResponse,
} from "@gantry/shared";
import { publicClient, relayerAccount, tokenDomain } from "../chain";
import { config } from "../config";
import { validateExactPayment } from "./facilitator-core";

/**
 * The facilitator's verify side. Spec-shaped: payment problems come back as
 * `isValid: false` with an invalidReason — never thrown — because that is how
 * both the @x402 resource server and the HTTP route consume them.
 */

export function getSupported(): X402SupportedResponse {
  return {
    kinds: [{ x402Version: 2, scheme: "exact", network: caip2(config.chainId) }],
    extensions: [],
    signers: {},
  };
}

export async function verifyExact(
  payload: X402PaymentPayload,
  requirements: X402PaymentRequirements,
): Promise<X402VerifyResponse> {
  const tokenId = tokenIdByAddress(config.addresses, requirements.asset);
  if (!tokenId) {
    return {
      isValid: false,
      invalidReason: "unknown_asset",
      invalidMessage: `asset ${requirements.asset} is not a listed pay token`,
    };
  }

  const validation = await validateExactPayment({
    payload,
    requirements,
    now: Math.floor(Date.now() / 1000),
    relayer: relayerAccount.address,
    expectedNetwork: caip2(config.chainId),
    domain: tokenDomain(tokenId),
  });
  if (!validation.ok) {
    return {
      isValid: false,
      invalidReason: validation.failure.reason,
      invalidMessage: validation.failure.message,
    };
  }

  const { authorization } = validation.exact;
  const [used, balance] = await Promise.all([
    publicClient.readContract({
      address: requirements.asset,
      abi: eip3009TokenAbi,
      functionName: "authorizationState",
      args: [authorization.from, authorization.nonce],
    }),
    publicClient.readContract({
      address: requirements.asset,
      abi: eip3009TokenAbi,
      functionName: "balanceOf",
      args: [authorization.from],
    }),
  ]);
  if (used) {
    return {
      isValid: false,
      invalidReason: "authorization_already_used",
      invalidMessage: "authorization nonce already consumed on-chain",
      payer: authorization.from,
    };
  }
  if (balance < BigInt(authorization.value)) {
    return {
      isValid: false,
      invalidReason: "insufficient_funds",
      invalidMessage: "payer balance below authorization value",
      payer: authorization.from,
    };
  }

  return { isValid: true, payer: authorization.from };
}
