import { type Address, type Hex } from "viem";
import {
  IntentStatus,
  caip2,
  gantryCoreAbi,
  type X402PaymentPayload,
  type X402PaymentRequirements,
  type X402SettleResponse,
} from "@gantry/shared";
import { publicClient } from "../chain";
import { config } from "../config";
import { getIntentRow, setIntentStatus } from "../db";
import { failure, isDefiniteFailure, reasonAndMessage, tryCancelIntent } from "./bridge";
import { verifyPbm } from "./facilitator";
import { GantryPbmPayloadSchema } from "./pbm-core";
import { settlePbm } from "./settlement";

/**
 * The `gantry-pbm` settle wrapper — the bridge's non-custodial sibling, a
 * third its size because nothing is ever custodied: the intent was pre-created
 * by the client (POST /api/pbm/intent), the wallet pushes funds straight to
 * the core inside the single settleFromPBM tx, and there is no collect and no
 * refund machinery. The only compensation is cancelling the intent so a
 * denied purchase leaves no Pending litter on Basescan.
 *
 * The denial beat lives here: simulate-before-send inside sendRelayerTx
 * surfaces the wallet's policy revert (CategoryNotAllowed & co) pre-broadcast;
 * reasonAndMessage decodes it through gantryErrorsAbi and the custom name
 * travels verbatim as the x402 errorReason.
 */
export async function settlePbmScheme(
  payload: X402PaymentPayload,
  requirements: X402PaymentRequirements,
): Promise<X402SettleResponse> {
  try {
    return await runPbmSettle(payload, requirements);
  } catch (err) {
    // The @x402 middleware maps a *thrown* settle to a generic failure built
    // from err.message — returning our own shape keeps the decoded-reason
    // vocabulary and the payer field intact instead.
    console.error("pbm: unexpected failure", err);
    return failure("settlement_failed", err instanceof Error ? err.message : String(err));
  }
}

async function runPbmSettle(
  payload: X402PaymentPayload,
  requirements: X402PaymentRequirements,
): Promise<X402SettleResponse> {
  // Re-verify even though the middleware already did — the spec-shaped HTTP
  // /facilitator/settle surface can be called directly (bridge precedent).
  const verified = await verifyPbm(payload, requirements);
  if (!verified.isValid) {
    return failure(
      verified.invalidReason ?? "verification_failed",
      verified.invalidMessage ?? "payment failed verification",
      verified.payer,
    );
  }
  const { pbmWallet, intentId, signature } = GantryPbmPayloadSchema.parse(payload.payload);

  try {
    const settled = await settlePbm({ intentId, pbmWallet, agentSig: signature });
    return {
      success: true,
      transaction: settled.txHash,
      network: caip2(config.chainId),
      payer: pbmWallet,
      amount: requirements.amount,
    };
  } catch (err) {
    console.error(`pbm: settle of intent ${intentId} from wallet ${pbmWallet} threw`, err);
    return resolveFailedPbmSettle(err, intentId, pbmWallet, requirements);
  }
}

/**
 * Never assume "the helper threw ⇒ the tx did not happen" — receipt timeouts
 * leave a broadcast settleFromPBM that may still mine. Definite failures
 * (decoded reverts — the policy denials — or pre-broadcast ApiErrors) just
 * cancel the intent; ambiguous outcomes are proven on-chain first via the
 * intent status and the cancel-tx nonce-ordering trick (a cancel that lands
 * proves the stuck settle was consumed; IntentAlreadySettled proves it won).
 */
async function resolveFailedPbmSettle(
  err: unknown,
  intentId: Hex,
  pbmWallet: Address,
  requirements: X402PaymentRequirements,
): Promise<X402SettleResponse> {
  const { reason, message } = reasonAndMessage(err);

  if (isDefiniteFailure(err)) {
    await tryCancelIntent(intentId);
    return failure(reason, message, pbmWallet);
  }

  const status = await readIntentStatus(intentId).catch(() => null);
  if (status === IntentStatus.Settled) return pbmSettleLandedAfterAll(intentId, pbmWallet, requirements);

  const cancelled = await tryCancelIntent(intentId);
  if (cancelled === "already_settled") return pbmSettleLandedAfterAll(intentId, pbmWallet, requirements);
  if (cancelled === "cancelled") {
    return failure(reason, `settlement did not land; intent cancelled — ${message}`, pbmWallet);
  }
  // Unresolved, but nothing is custodied: the intent expires on its own and
  // the wallet's funds never left it unless the settle mined (in which case
  // the indexer sweep will surface the row).
  return failure(reason, `${message} (settle outcome unresolved — no funds are custodied)`, pbmWallet);
}

function pbmSettleLandedAfterAll(
  intentId: Hex,
  pbmWallet: Address,
  requirements: X402PaymentRequirements,
): X402SettleResponse {
  console.error(`pbm: settlement of intent ${intentId} landed despite the thrown error — reporting success`);
  try {
    setIntentStatus(intentId, "settled");
  } catch (dbErr) {
    console.error(`pbm: cache update failed for settled intent ${intentId}:`, dbErr);
  }
  // Tx hash unknown here (the receipt never came back); the indexer sweep
  // fills settle_tx and broadcasts the dashboard row when it sees the log.
  return {
    success: true,
    transaction: getIntentRow(intentId)?.settle_tx ?? "",
    network: caip2(config.chainId),
    payer: pbmWallet,
    amount: requirements.amount,
  };
}

function readIntentStatus(intentId: Hex): Promise<number> {
  return publicClient
    .readContract({
      address: config.addresses.gantryCore,
      abi: gantryCoreAbi,
      functionName: "getIntent",
      args: [intentId],
    })
    .then((intent) => intent.status);
}
