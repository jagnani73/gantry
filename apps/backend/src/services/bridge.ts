import { type Address, type Hex } from "viem";
import {
  Door,
  buildTransferAuthorization,
  caip2,
  decodeGantryError,
  describeGantryError,
  eip3009TokenAbi,
  gantryCoreAbi,
  tokenIdByAddress,
  type IntentResponse,
  type X402ExactEvmPayload,
  type X402PaymentPayload,
  type X402PaymentRequirements,
  type X402SettleResponse,
} from "@gantry/shared";
import { publicClient, relayerAccount, tokenDomain } from "../chain";
import { config } from "../config";
import { getIntentRow, setIntentAgentPayer, setIntentStatus } from "../db";
import { ApiError } from "../errors";
import { sendRelayerTx } from "../relayer";
import { ExactEvmPayloadSchema, parseOrderPins, reasonForGantryError, splitSignature65 } from "./facilitator-core";
import { verifyExact } from "./facilitator";
import { createIntent } from "./intents";
import { settle } from "./settlement";

/**
 * The facilitator bridge: vanilla x402 `exact` payloads carry a random
 * EIP-3009 nonce, which the frozen core cannot settle (it hardcodes
 * nonce = intentId). So the bridge creates the Agent-door intent, collects the
 * agent's standard authorization onto the relayer, and settles the intent with
 * a relayer-self-signed authorization — every payment still lands through
 * GantryCore._settle, and the dashboard's Agent badge comes from the intent.
 *
 * Ordering is deliberate: intent + quote guard BEFORE funds move, so the only
 * compensation window is a failure after a successful collect. Compensation
 * never assumes "the helper threw ⇒ the tx did not happen": receipt timeouts
 * leave a broadcast tx that may still mine, so ambiguous outcomes are resolved
 * on-chain (authorizationState + the cancel-tx nonce ordering) before any
 * refund moves money — see resolveFailedCollect/resolveFailedSettle.
 */
export async function settleBridge(
  payload: X402PaymentPayload,
  requirements: X402PaymentRequirements,
): Promise<X402SettleResponse> {
  try {
    return await runBridge(payload, requirements);
  } catch (err) {
    // The @x402 middleware maps a *thrown* settle to a generic failure built
    // from err.message — returning our own shape keeps the decoded-reason
    // vocabulary and the payer field intact instead.
    console.error("bridge: unexpected failure", err);
    return failure("settlement_failed", err instanceof Error ? err.message : String(err));
  }
}

export function failure(errorReason: string, errorMessage: string, payer?: Address): X402SettleResponse {
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
export function reasonAndMessage(err: unknown): { reason: string; message: string } {
  if (err instanceof ApiError) return { reason: err.errorName, message: err.message };
  const decoded = decodeGantryError(err);
  return { reason: reasonForGantryError(decoded), message: describeGantryError(decoded) };
}

/** True when the error PROVES no state changed: a decoded contract revert or
 * token string revert (tx executed and reverted), a mined-but-reverted receipt
 * from the relayer, or an ApiError raised before broadcast. Receipt timeouts
 * and transport failures stay ambiguous — the tx may still mine. */
export function isDefiniteFailure(err: unknown): boolean {
  if (err instanceof ApiError) return true;
  if (err instanceof Error && /reverted on-chain/.test(err.message)) return true;
  return decodeGantryError(err).kind !== "unknown";
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

  // The order facts come from the server-pinned requirements.extra — never
  // from the client-echoed resource URL (a client could echo a different
  // merchant's URL at the same price).
  const pins = parseOrderPins(requirements.extra);
  if (!pins) {
    return failure(
      "invalid_requirements",
      "requirements.extra must pin handle and xsgdAmount (is this a gantry order requirement?)",
      authorization.from,
    );
  }
  // verifyExact already rejected unknown assets.
  const tokenId = tokenIdByAddress(config.addresses, requirements.asset)!;

  // 1. Intent first (Agent door) and quote guard — nothing at stake yet.
  let intent: IntentResponse;
  try {
    intent = await createIntent(
      { handle: pins.handle, xsgdAmount: pins.xsgdAmount.toString(), token: tokenId },
      Door.Agent,
    );
  } catch (err) {
    console.error(`bridge: createIntent for ${pins.handle} failed`, err);
    const { reason, message } = reasonAndMessage(err);
    return failure(reason, message, authorization.from);
  }
  setIntentAgentPayer(intent.intentId, authorization.from);
  if (BigInt(intent.amountIn) !== BigInt(requirements.amount)) {
    await tryCancelIntent(intent.intentId);
    return failure(
      "quote_changed",
      `quote moved between challenge and settle (${requirements.amount} → ${intent.amountIn}); retry the order`,
      authorization.from,
    );
  }

  // 2. Collect the agent's standard authorization onto the relayer.
  const { v, r, s } = splitSignature65(signature);
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
        v,
        r,
        s,
      ],
    });
    collectTx = receipt.transactionHash;
  } catch (err) {
    console.error(
      `bridge: collect of ${authorization.value} ${requirements.asset} from ${authorization.from} ` +
        `(nonce ${authorization.nonce}, intent ${intent.intentId}) failed`,
      err,
    );
    return resolveFailedCollect(err, intent, authorization, requirements);
  }

  // 3. Relayer self-signs nonce=intentId and settles through the M1 path;
  //    IntentSettled(door=agent) then feeds the dashboard SSE on its own.
  try {
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
        `(tx ${collectTx}) but settlement of intent ${intent.intentId} threw — resolving outcome`,
      err,
    );
    return resolveFailedSettle(err, intent, authorization, requirements, collectTx);
  }
}

/**
 * The collect helper threw. On a definite revert nothing moved — cancel and
 * report. Otherwise the collect tx may still mine: cancelIntent is queued on
 * the SAME relayer nonce stream, so a cancel that lands proves the collect tx
 * was consumed (mined or reverted) — authorizationState then says which.
 */
async function resolveFailedCollect(
  err: unknown,
  intent: IntentResponse,
  authorization: X402ExactEvmPayload["authorization"],
  requirements: X402PaymentRequirements,
): Promise<X402SettleResponse> {
  const from = authorization.from;
  const { reason, message } = reasonAndMessage(err);
  if (isDefiniteFailure(err)) {
    await tryCancelIntent(intent.intentId);
    return failure(reason, message, from);
  }
  const cancelled = await tryCancelIntent(intent.intentId);
  if (cancelled === "cancelled") {
    const landed = await readAuthorizationState(requirements.asset, from, authorization.nonce).catch(
      () => null,
    );
    if (landed === false) {
      // collect provably dead (cancel consumed the nonce stream behind it)
      return failure(reason, message, from);
    }
    if (landed === true) {
      console.error(
        `bridge CRITICAL: ambiguous collect DID land for intent ${intent.intentId} — refunding ${from}`,
      );
      await refundQuietly(requirements.asset, from, BigInt(authorization.value));
      return failure(reason, `collect landed but settlement was aborted; funds refunded — ${message}`, from);
    }
  }
  console.error(
    `bridge CRITICAL: collect outcome UNRESOLVED for intent ${intent.intentId}. ` +
      `If token.authorizationState(${from}, ${authorization.nonce}) turns true, ` +
      `refund manually: token.transfer(${from}, ${authorization.value}).`,
  );
  return failure(reason, `${message} (collect outcome unresolved — manual review logged)`, from);
}

/**
 * The settle helper threw AFTER a successful collect. settle() can throw with
 * the settlement mined (receipt timeout, log-parse or DB failure after
 * confirmation) — refunding then would double-pay, so the outcome is proven
 * on-chain first: the relayer's own intentId-nonce authorization is consumed
 * iff settleWithAuthorization succeeded.
 */
async function resolveFailedSettle(
  err: unknown,
  intent: IntentResponse,
  authorization: X402ExactEvmPayload["authorization"],
  requirements: X402PaymentRequirements,
  collectTx: Hex,
): Promise<X402SettleResponse> {
  const from = authorization.from;
  const value = BigInt(authorization.value);
  const { reason, message } = reasonAndMessage(err);

  if (isDefiniteFailure(err)) {
    await tryCancelIntent(intent.intentId);
    await refundQuietly(requirements.asset, from, value);
    return failure(reason, message, from);
  }

  const settledOnChain = await readAuthorizationState(
    requirements.asset,
    relayerAccount.address,
    intent.intentId,
  ).catch(() => null);
  if (settledOnChain === true) return settleLandedAfterAll(intent, requirements, from);

  // Same nonce-ordering trick as the collect path: a cancel that lands proves
  // the pending settle tx was consumed; IntentAlreadySettled proves it won.
  const cancelled = await tryCancelIntent(intent.intentId);
  if (cancelled === "already_settled") return settleLandedAfterAll(intent, requirements, from);
  if (cancelled === "cancelled") {
    await refundQuietly(requirements.asset, from, value);
    return failure(reason, `settlement did not land; funds refunded — ${message}`, from);
  }

  console.error(
    `bridge CRITICAL: settle outcome UNRESOLVED for intent ${intent.intentId} (collect tx ${collectTx}). ` +
      `If getIntent shows Settled all is well; otherwise refund manually: ` +
      `token.transfer(${from}, ${value}). No refund was sent.`,
  );
  return failure(reason, `${message} (settle outcome unresolved — funds held pending manual review)`, from);
}

function settleLandedAfterAll(
  intent: IntentResponse,
  requirements: X402PaymentRequirements,
  from: Address,
): X402SettleResponse {
  console.error(
    `bridge: settlement of intent ${intent.intentId} landed despite the thrown error — reporting success`,
  );
  try {
    setIntentStatus(intent.intentId, "settled");
  } catch (dbErr) {
    console.error(`bridge: cache update failed for settled intent ${intent.intentId}:`, dbErr);
  }
  // Tx hash unknown here (the receipt never came back); the indexer sweep
  // fills settle_tx and broadcasts the dashboard row when it sees the log.
  return {
    success: true,
    transaction: getIntentRow(intent.intentId)?.settle_tx ?? "",
    network: caip2(config.chainId),
    payer: from,
    amount: requirements.amount,
  };
}

type CancelOutcome = "cancelled" | "already_settled" | "failed";

/** Cancels a pending bridge intent, branching on WHY a cancel could not land —
 * IntentAlreadySettled is load-bearing evidence for the settle resolver. */
export async function tryCancelIntent(intentId: Hex): Promise<CancelOutcome> {
  try {
    await sendRelayerTx({
      address: config.addresses.gantryCore,
      abi: gantryCoreAbi,
      functionName: "cancelIntent",
      args: [intentId],
    });
  } catch (err) {
    const decoded = decodeGantryError(err);
    if (decoded.kind === "custom" && decoded.name === "IntentAlreadySettled") {
      console.error(`bridge: cancel of ${intentId} reverted IntentAlreadySettled — settlement landed`);
      return "already_settled";
    }
    console.error(`bridge: cancel of intent ${intentId} failed (it will expire on its own):`, err);
    return "failed";
  }
  try {
    setIntentStatus(intentId, "cancelled");
  } catch (dbErr) {
    console.error(`bridge: cancel landed but cache update failed for ${intentId}:`, dbErr);
  }
  return "cancelled";
}

function readAuthorizationState(asset: Address, authorizer: Address, nonce: Hex): Promise<boolean> {
  return publicClient.readContract({
    address: asset,
    abi: eip3009TokenAbi,
    functionName: "authorizationState",
    args: [authorizer, nonce],
  });
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
