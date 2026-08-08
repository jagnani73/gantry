import { keccak256, toBytes, type Address, type Hex } from "viem";
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
import { getIntentRow, insertDenial, setIntentStatus } from "../db";
import {
  failure,
  isDefiniteFailure,
  reasonAndMessage,
  tryCancelIntent,
  tryCancelIntentWithTx,
} from "./bridge";
import { parseOrderPins } from "./facilitator-core";
import { verifyPbm } from "./facilitator";
import { GantryPbmPayloadSchema, policyDenialOf } from "./pbm-core";
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
    // The cancel is the only tx a denial leaves behind, so take its hash on the
    // way past — the payer's receipt has nothing else to link to.
    const cancel = await tryCancelIntentWithTx(intentId);
    recordPbmDenial(err, intentId, pbmWallet, requirements, cancel.txHash);
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

/**
 * A refused purchase is the one payment outcome that leaves NOTHING on-chain:
 * the wallet's policy revert is caught by simulate-before-send and never
 * broadcast, so no event exists and no log can be swept. This row is the only
 * trace it happened, and the payer's activity renders it as "Declined
 * on-chain" — which is why `policyDenialOf` returns null for anything that is
 * not a decoded wallet policy error. Writing a row for a transport blip or a
 * core-level revert would put a fabricated claim about the chain on a screen.
 * The caller's isDefiniteFailure gate is the other half of that: an outcome
 * that might still mine is not a denial either.
 *
 * Order facts come from the server-pinned requirements.extra, never a client
 * echo (the bridge's trust rule) — and verification already proved they match
 * the intent, so no read is needed to restate them.
 *
 * The guard wraps the WHOLE body, decode and all. Its caller has already
 * computed the reason it is about to return, and the only catch above it is
 * settlePbmScheme's, which discards that and answers `settlement_failed` — so a
 * throw anywhere in here (a malformed revert the decoder chokes on, a pin that
 * is not a string) would collapse `CategoryNotAllowed` into noise and take the
 * sharpest beat in the demo with it. Nothing here may fail loudly.
 */
function recordPbmDenial(
  err: unknown,
  intentId: Hex,
  pbmWallet: Address,
  requirements: X402PaymentRequirements,
  cancelTx: Hex | null,
): void {
  try {
    const denial = policyDenialOf(err);
    if (!denial) return;

    const pins = parseOrderPins(requirements.extra);
    if (!pins) {
      console.error(`pbm: denial of intent ${intentId} not recorded — requirements pin no order facts`);
      return;
    }

    insertDenial({
      intent_id: intentId,
      handle: pins.handle,
      merchant_id: keccak256(toBytes(pins.handle)),
      wallet: pbmWallet,
      token_in: requirements.asset,
      amount_in: requirements.amount,
      xsgd_amount: pins.xsgdAmount.toString(),
      error_name: denial.errorName,
      error_args: denial.errorArgs ? JSON.stringify(denial.errorArgs) : null,
      cancel_tx: cancelTx,
      created_at: Math.floor(Date.now() / 1000),
    });
  } catch (recordErr) {
    // The payment outcome is authoritative and already decided; this row is a
    // convenience. Nothing on this path — decoding the revert, reading the pins
    // or the cache write itself — may turn a handled x402 failure into a thrown
    // one, nor change the response the agent gets.
    console.error(`pbm: recording the denial of intent ${intentId} failed`, recordErr);
  }
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
