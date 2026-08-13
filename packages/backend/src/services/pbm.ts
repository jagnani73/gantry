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
import { safeMessage } from "../redact";
import { getIntentRow, insertDenial, setIntentStatus } from "../db";
import {
  failure,
  isDefiniteFailure,
  reasonAndMessage,
  tryCancelIntent,
  tryCancelIntentWithTx,
} from "./bridge";
import { verifyPbm } from "./facilitator";
import { GantryPbmPayloadSchema, denialReasonBytes, policyDenialOf } from "./pbm-core";
import { parseOrderPins } from "./facilitator-core";
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
    return failure("settlement_failed", safeMessage(err));
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
    // The cancel is the only transaction a denial leaves behind — so when this
    // failure IS a policy denial, the cancel is also where it gets recorded. The
    // wallet's verbatim revert bytes ride along and the core emits IntentDenied,
    // which the indexer sweeps into the denials table on EVERY host. Before this,
    // the only record was a row written here, on whichever backend happened to
    // refuse the payment; nothing on-chain, so no other host could ever learn of
    // it and a rebuilt cache lost it. `denialReasonOf` returns null for anything
    // that is not a decoded wallet policy error, so an ordinary failure still
    // takes the plain cancel and writes nothing.
    const denial = denialReasonOf(err, intentId, pbmWallet);
    const cancel = await tryCancelIntentWithTx(intentId, denial ?? undefined);
    // `already_settled` is not a refusal at all — the payment landed, and the old
    // code's unconditional write put a "Declined on-chain" row over a settlement.
    if (denial && !cancel.denialRecorded && cancel.outcome !== "already_settled") {
      recordDenialLocally(err, intentId, pbmWallet, requirements, cancel.txHash);
    }
    return failure(reason, message, pbmWallet);
  }

  const status = await readIntentStatus(intentId).catch(() => null);
  if (status === IntentStatus.Settled) return pbmSettleLandedAfterAll(intentId, pbmWallet, requirements);

  const cancelled = await tryCancelIntent(intentId);
  if (cancelled === "already_settled") return pbmSettleLandedAfterAll(intentId, pbmWallet, requirements);
  if (cancelled === "cancelled") {
    return failure(reason, `settlement did not land; intent cancelled (${message})`, pbmWallet);
  }
  // Unresolved, but nothing is custodied: the intent expires on its own and
  // the wallet's funds never left it unless the settle mined (in which case
  // the indexer sweep will surface the row).
  return failure(reason, `${message} (settle outcome unresolved; no funds are custodied)`, pbmWallet);
}

/**
 * A refused purchase reaches the chain ONLY through its cancellation.
 *
 * The wallet's policy revert is caught by simulate-before-send and never
 * broadcast — and a reverted transaction carries no logs even when one is, since
 * a revert rolls its events back — so there is no failed transaction to sweep.
 * The cancel DOES succeed, so `cancelIntentWithReason` carries these bytes into
 * an `IntentDenied` event and every host's indexer writes the row from it. It
 * used to be written straight into this process's SQLite, which meant the only
 * evidence a payment had been refused lived on whichever backend refused it.
 *
 * The gating is in `pbm-core` so it is unit-testable without an environment.
 */
function denialReasonOf(
  err: unknown,
  intentId: Hex,
  pbmWallet: Address,
): { wallet: Address; reason: Hex } | null {
  const reason = denialReasonBytes(err, (why) =>
    console.error(`pbm: intent ${intentId} ${why} — cancelling without a reason`),
  );
  return reason ? { wallet: pbmWallet, reason } : null;
}

/**
 * The refusal happened; its ON-CHAIN record did not. Write the row here so it is
 * not lost entirely.
 *
 * The chain is the primary path — every host sweeps `IntentDenied` and agrees —
 * but it depends on a transaction landing, and when that fails the alternative is
 * a payer whose agent narrated `CategoryNotAllowed` while their activity feed
 * shows nothing at all. This row is host-local, exactly as the whole table used
 * to be, and `insertDenial` is INSERT OR REPLACE keyed by intent, so the indexer
 * upgrades it in place if the cancel turns out to have mined after all.
 *
 * `cancel_tx` is null when no cancel landed, and the payer's receipt renders that
 * honestly rather than inventing a hash — the branch that says "the cancel did
 * not land, so the intent expires on its own" exists for precisely this row.
 *
 * Nothing here may throw: the caller has already computed the response it is
 * about to return, and the only catch above answers `settlement_failed`.
 */
function recordDenialLocally(
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
    console.error(
      `pbm: denial of intent ${intentId} may not have reached the chain — recorded locally. ` +
        "If the cancel mined after all, the indexer will replace this row.",
    );
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
    console.error(`pbm: recording the denial of intent ${intentId} locally failed`, recordErr);
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
