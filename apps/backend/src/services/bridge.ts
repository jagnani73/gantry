import { parseSignature, type Address, type Hex } from "viem";
import {
  Door,
  buildTransferAuthorization,
  caip2,
  decodeGantryError,
  describeGantryError,
  eip3009TokenAbi,
  gantryCoreAbi,
  parseSgd,
  tokenIdByAddress,
  type X402PaymentPayload,
  type X402PaymentRequirements,
  type X402SettleResponse,
} from "@gantry/shared";
import { relayerAccount, tokenDomain } from "../chain";
import { config } from "../config";
import { setIntentStatus } from "../db";
import { ApiError } from "../errors";
import { sendRelayerTx } from "../relayer";
import { ExactEvmPayloadSchema, parseOrderResource, reasonForGantryError } from "./facilitator-core";
import { verifyExact } from "./facilitator";
import { createIntent } from "./intents";
import { settle } from "./settlement";

/**
 * The facilitator bridge: vanilla x402 `exact` payloads carry a random
 * EIP-3009 nonce, which the frozen core cannot settle (it hardcodes
 * nonce = intentId). So the bridge collects the agent's standard authorization
 * onto the relayer, creates the Agent-door intent, and settles it with a
 * relayer-self-signed authorization — every payment still lands through
 * GantryCore._settle, and the dashboard's Agent badge comes from the intent.
 *
 * Ordering is deliberate: intent + quote guard BEFORE funds move, so the only
 * refund window is a settle failure after a successful collect.
 */
export async function settleBridge(
  payload: X402PaymentPayload,
  requirements: X402PaymentRequirements,
): Promise<X402SettleResponse> {
  try {
    return await runBridge(payload, requirements);
  } catch (err) {
    // The @x402 middleware treats a *thrown* settle as an opaque 402 — always
    // hand it a spec-shaped failure instead.
    console.error("bridge: unexpected failure", err);
    return failure("settlement_failed", err instanceof Error ? err.message : String(err));
  }
}

function failure(errorReason: string, errorMessage: string, payer?: Address): X402SettleResponse {
  return {
    success: false,
    errorReason,
    errorMessage,
    transaction: "",
    network: caip2(config.chainId),
    ...(payer ? { payer } : {}),
  };
}

/** ApiError keeps its wire name (MerchantNotFound…); contract reverts go
 * through the shared decoder — never backend if-statements. */
function reasonAndMessage(err: unknown): { reason: string; message: string } {
  if (err instanceof ApiError) return { reason: err.errorName, message: err.message };
  const decoded = decodeGantryError(err);
  return { reason: reasonForGantryError(decoded), message: describeGantryError(decoded) };
}

async function runBridge(
  payload: X402PaymentPayload,
  requirements: X402PaymentRequirements,
): Promise<X402SettleResponse> {
  const verified = await verifyExact(payload, requirements);
  if (!verified.isValid) {
    return failure(
      verified.invalidReason ?? "verification_failed",
      verified.invalidMessage ?? "payment failed verification",
      verified.payer,
    );
  }
  const { authorization, signature } = ExactEvmPayloadSchema.parse(payload.payload);

  const resourceUrl = payload.resource?.url;
  if (!resourceUrl) {
    return failure("missing_resource", "payload.resource.url is required to price the order", authorization.from);
  }
  const order = parseOrderResource(resourceUrl);
  if (!order) {
    return failure("invalid_resource", `not a gantry order URL with an sgd param: ${resourceUrl}`, authorization.from);
  }
  let xsgdAmount: bigint;
  try {
    xsgdAmount = parseSgd(order.sgd);
  } catch {
    return failure("invalid_resource", `unparseable sgd amount "${order.sgd}"`, authorization.from);
  }

  // verifyExact already resolved the asset; re-derive for the domain lookup.
  const tokenId = tokenIdByAddress(config.addresses, requirements.asset);
  if (!tokenId) return failure("unknown_asset", `asset ${requirements.asset} is not a listed pay token`);

  // 1. Intent first (Agent door) and quote guard — nothing at stake yet.
  let intent;
  try {
    intent = await createIntent({ handle: order.handle, xsgdAmount: xsgdAmount.toString(), token: tokenId }, Door.Agent);
  } catch (err) {
    const { reason, message } = reasonAndMessage(err);
    return failure(reason, message, authorization.from);
  }
  if (intent.amountIn !== requirements.amount) {
    await cancelIntentQuietly(intent.intentId);
    return failure(
      "quote_changed",
      `quote moved between challenge and settle (${requirements.amount} → ${intent.amountIn}); retry the order`,
      authorization.from,
    );
  }

  // 2. Collect the agent's standard authorization onto the relayer.
  const { v, r, s, yParity } = parseSignature(signature);
  const vNorm = Number(v ?? BigInt(yParity + 27));
  let collectTx: Hex;
  try {
    const { receipt } = await sendRelayerTx({
      address: requirements.asset,
      abi: eip3009TokenAbi,
      functionName: "transferWithAuthorization",
      args: [
        authorization.from,
        relayerAccount.address,
        BigInt(authorization.value),
        BigInt(authorization.validAfter),
        BigInt(authorization.validBefore),
        authorization.nonce,
        vNorm,
        r,
        s,
      ],
    });
    collectTx = receipt.transactionHash;
  } catch (err) {
    await cancelIntentQuietly(intent.intentId);
    const { reason, message } = reasonAndMessage(err);
    return failure(reason, message, authorization.from);
  }

  // 3. Relayer self-signs nonce=intentId and settles through the M1 path;
  //    IntentSettled(door=agent) then feeds the dashboard SSE on its own.
  const validBefore = BigInt(intent.validBefore);
  const selfSignature = await relayerAccount.signTypedData(
    buildTransferAuthorization({
      domain: tokenDomain(tokenId),
      from: relayerAccount.address,
      to: config.addresses.gantryCore,
      value: BigInt(intent.amountIn),
      validAfter: 0n,
      validBefore,
      nonce: intent.intentId,
    }),
  );
  try {
    const settled = await settle({
      intentId: intent.intentId,
      payer: relayerAccount.address,
      signature: selfSignature,
      validAfter: 0n,
      validBefore,
    });
    return {
      success: true,
      transaction: settled.txHash,
      network: caip2(config.chainId),
      payer: authorization.from,
      amount: requirements.amount,
    };
  } catch (err) {
    console.error(
      `bridge CRITICAL: collected ${authorization.value} of ${requirements.asset} from ${authorization.from} ` +
        `(tx ${collectTx}) but settlement of intent ${intent.intentId} failed — refunding`,
      err,
    );
    await cancelIntentQuietly(intent.intentId);
    await refundQuietly(requirements.asset, authorization.from, BigInt(authorization.value));
    const { reason, message } = reasonAndMessage(err);
    return failure(reason, message, authorization.from);
  }
}

/** A pending intent left behind just expires on its own — cancellation is a
 * cleanliness step, never worth failing the response over. */
async function cancelIntentQuietly(intentId: Hex): Promise<void> {
  try {
    await sendRelayerTx({
      address: config.addresses.gantryCore,
      abi: gantryCoreAbi,
      functionName: "cancelIntent",
      args: [intentId],
    });
    setIntentStatus(intentId, "cancelled");
  } catch (err) {
    console.error(`bridge: cancel of intent ${intentId} failed (it will expire):`, err);
  }
}

async function refundQuietly(asset: Address, to: Address, value: bigint): Promise<void> {
  try {
    const { receipt } = await sendRelayerTx({
      address: asset,
      abi: eip3009TokenAbi,
      functionName: "transfer",
      args: [to, value],
    });
    console.error(`bridge: refunded ${value} to ${to} in ${receipt.transactionHash}`);
  } catch (err) {
    console.error(
      `bridge CRITICAL: refund FAILED — ${value} of ${asset} for ${to} is parked on the relayer. ` +
        `Manual recovery: token.transfer(${to}, ${value}).`,
      err,
    );
  }
}
