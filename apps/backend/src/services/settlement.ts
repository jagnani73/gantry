import { parseEventLogs, parseSignature, type Address, type Hex, type TransactionReceipt } from "viem";
import {
  decodeGantryError,
  describeGantryError,
  gantryCoreAbi,
  isStaleStateRevert,
  type SettleResponse,
} from "@gantry/shared";
import { config } from "../config";
import { getIntentRow, setIntentStatus } from "../db";
import { ApiError } from "../errors";
import { sendRelayerTx } from "../relayer";
import { storedValidBefore } from "./intents";

export interface SettleParams {
  intentId: Hex;
  payer: Address;
  signature: Hex;
  validAfter?: bigint;
  validBefore?: bigint;
}

export interface SettlePbmParams {
  intentId: Hex;
  pbmWallet: Address;
  agentSig: Hex;
}

/** Deterministic replay guard shared by both settle doors: simulation alone
 * can pass against a replica that hasn't seen the settle yet, broadcasting a
 * doomed tx (burned gas). */
function assertNotReplayed(intentId: Hex): void {
  const cached = getIntentRow(intentId);
  if (cached?.status === "settled") {
    throw new ApiError(409, "IntentAlreadySettled", "intent already settled", {
      txHash: cached.settle_tx,
    });
  }
  if (cached?.status === "cancelled") {
    throw new ApiError(409, "IntentWasCancelled", "intent was cancelled (requote and retry)");
  }
}

/**
 * RPC replicas can lag a block: a just-created intent simulates as
 * UnknownIntent, a just-minted balance as insufficient. Bounded retry on
 * exactly those stale-state shapes; everything else throws immediately.
 * (PBMPullFailed and the wallet's own errors are deliberately NOT in the
 * stale set — a policy denial retried 5x would still deny, slower.)
 */
async function sendWithStaleRetry(
  intentId: Hex,
  send: () => Promise<{ receipt: TransactionReceipt }>,
): Promise<TransactionReceipt> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { receipt } = await send();
      return receipt;
    } catch (err) {
      const decoded = decodeGantryError(err);
      if (!isStaleStateRevert(decoded) || attempt >= 5) throw err;
      console.warn(`settle retry ${attempt}/5 for ${intentId}: ${describeGantryError(decoded)}`);
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
}

function settleResponseFrom(intentId: Hex, receipt: TransactionReceipt): SettleResponse {
  const [settled] = parseEventLogs({
    abi: gantryCoreAbi,
    logs: receipt.logs,
    eventName: "IntentSettled",
  });
  if (!settled) throw new Error(`IntentSettled log missing in tx ${receipt.transactionHash}`);

  setIntentStatus(intentId, "settled", receipt.transactionHash);

  return {
    status: "settled",
    intentId,
    txHash: receipt.transactionHash,
    blockNumber: Number(receipt.blockNumber),
    xsgdOut: settled.args.xsgdOut.toString(),
    feeXsgd: settled.args.feeXsgd.toString(),
  };
}

/**
 * The reusable settle path — M2's facilitator /verify + /settle calls this
 * same function. Simulation happens inside sendRelayerTx, so contract reverts
 * surface as decodable viem errors (mapped by the error middleware).
 */
export async function settle(params: SettleParams): Promise<SettleResponse> {
  assertNotReplayed(params.intentId);

  const validBeforeStored = storedValidBefore(params.intentId);
  const validBefore = params.validBefore ?? (validBeforeStored ? BigInt(validBeforeStored) : null);
  if (validBefore === null) {
    throw new ApiError(
      400,
      "ValidationError",
      "validBefore required (no cached quote for this intent)",
    );
  }
  const validAfter = params.validAfter ?? 0n;

  const { v, r, s, yParity } = parseSignature(params.signature);
  const vNorm = v ?? BigInt(yParity + 27);

  const receipt = await sendWithStaleRetry(params.intentId, () =>
    sendRelayerTx({
      address: config.addresses.gantryCore,
      abi: gantryCoreAbi,
      functionName: "settleWithAuthorization",
      args: [params.intentId, params.payer, validAfter, validBefore, Number(vNorm), r, s],
    }),
  );

  return settleResponseFrom(params.intentId, receipt);
}

/**
 * The pbm settle path: one tx, non-custodial (the wallet pushes straight to
 * the core inside settleFromPBM). Simulation happens inside sendRelayerTx, so
 * a wallet policy denial surfaces pre-broadcast as a decodable viem error —
 * that revert IS the rejection beat.
 */
export async function settlePbm(params: SettlePbmParams): Promise<SettleResponse> {
  assertNotReplayed(params.intentId);

  const receipt = await sendWithStaleRetry(params.intentId, () =>
    sendRelayerTx({
      address: config.addresses.gantryCore,
      abi: gantryCoreAbi,
      functionName: "settleFromPBM",
      args: [params.intentId, params.pbmWallet, params.agentSig],
    }),
  );

  return settleResponseFrom(params.intentId, receipt);
}
