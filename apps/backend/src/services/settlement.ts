import { parseEventLogs, parseSignature, type Address, type Hex } from "viem";
import { decodeGantryError, gantryCoreAbi, type SettleResponse } from "@gantry/shared";
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

/**
 * The reusable settle path — M2's facilitator /verify + /settle calls this
 * same function. Simulation happens inside sendRelayerTx, so contract reverts
 * surface as decodable viem errors (mapped by the error middleware).
 */
export async function settle(params: SettleParams): Promise<SettleResponse> {
  // Deterministic replay guard: simulation alone can pass against a replica
  // that hasn't seen the settle yet, broadcasting a doomed tx (burned gas).
  const cached = getIntentRow(params.intentId);
  if (cached?.status === "settled") {
    throw new ApiError(409, "IntentAlreadySettled", "intent already settled", {
      txHash: cached.settle_tx,
    });
  }
  if (cached?.status === "cancelled") {
    throw new ApiError(409, "IntentWasCancelled", "intent was cancelled (requote and retry)");
  }

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

  // RPC replicas can lag a block behind a just-created intent — a fresh
  // intent may simulate as UnknownIntent for a second or two. Bounded retry.
  let receipt;
  for (let attempt = 1; ; attempt++) {
    try {
      ({ receipt } = await sendRelayerTx({
        address: config.addresses.gantryCore,
        abi: gantryCoreAbi,
        functionName: "settleWithAuthorization",
        args: [params.intentId, params.payer, validAfter, validBefore, Number(vNorm), r, s],
      }));
      break;
    } catch (err) {
      const decoded = decodeGantryError(err);
      const staleState = decoded.kind === "custom" && decoded.name === "UnknownIntent";
      if (!staleState || attempt >= 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }

  const [settled] = parseEventLogs({
    abi: gantryCoreAbi,
    logs: receipt.logs,
    eventName: "IntentSettled",
  });
  if (!settled) throw new Error(`IntentSettled log missing in tx ${receipt.transactionHash}`);

  setIntentStatus(params.intentId, "settled", receipt.transactionHash);

  return {
    status: "settled",
    intentId: params.intentId,
    txHash: receipt.transactionHash,
    blockNumber: Number(receipt.blockNumber),
    xsgdOut: settled.args.xsgdOut.toString(),
    feeXsgd: settled.args.feeXsgd.toString(),
  };
}
