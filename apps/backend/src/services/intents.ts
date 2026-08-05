import { parseEventLogs, type Hex } from "viem";
import {
  Door,
  IntentStatus,
  doorFromWire,
  doorToWire,
  fixedRateSwapAbi,
  gantryCoreAbi,
  quoteAmountIn,
  toWireTypedData,
  tokenAddress,
  tokenIdByAddress,
  type CreateIntentRequest,
  type IntentResponse,
  type IntentStatusResponse,
  type IntentWireStatus,
  type TokenId,
} from "@gantry/shared";
import { publicClient, tokenDomain } from "../chain";
import { config } from "../config";
import { getIntentRow, insertIntentRow, setIntentStatus, type IntentRow } from "../db";
import { ApiError } from "../errors";
import { sendRelayerTx } from "../relayer";
import { getMerchant } from "./merchants";

const XSGD_IDENTITY_RATE = 1_000_000n;
/** Signature window = quote TTL + slack. The raw EIP-3009 sig is replayable
 * straight to the token until validBefore, so a tight window bounds the
 * known front-run exposure. */
const AUTH_WINDOW_SLACK_SECONDS = 120;

async function readRate(token: TokenId): Promise<bigint> {
  if (token === "XSGD") return XSGD_IDENTITY_RATE;
  const rate = await publicClient.readContract({
    address: config.addresses.fixedRateSwap,
    abi: fixedRateSwapAbi,
    functionName: "rateOf",
    args: [tokenAddress(config.addresses, token)],
  });
  if (rate === 0n) {
    throw new ApiError(400, "TokenUnsupported", `no swap rate listed for ${token}`);
  }
  return rate;
}

export async function createIntent(req: CreateIntentRequest): Promise<IntentResponse> {
  const merchant = await getMerchant(req.handle);

  if (!/^\d+$/.test(req.xsgdAmount)) {
    throw new ApiError(400, "ValidationError", "xsgdAmount must be a decimal string of 6dp units");
  }
  const xsgdAmount = BigInt(req.xsgdAmount);
  if (xsgdAmount <= 0n) {
    throw new ApiError(400, "ValidationError", "xsgdAmount must be positive");
  }

  const token = req.token ?? config.defaultToken;
  const door = doorFromWire(req.door);
  const tokenIn = tokenAddress(config.addresses, token);
  const rate = await readRate(token);
  const amountIn = token === "XSGD" ? xsgdAmount : quoteAmountIn(xsgdAmount, rate);

  // Chain time, not server clock — a skewed laptop otherwise mints born-expired intents.
  const block = await publicClient.getBlock();
  const expiry = block.timestamp + BigInt(config.intentTtlSeconds);
  const validBefore = expiry + BigInt(AUTH_WINDOW_SLACK_SECONDS);

  const { receipt } = await sendRelayerTx({
    address: config.addresses.gantryCore,
    abi: gantryCoreAbi,
    functionName: "createIntent",
    args: [merchant.merchantId, xsgdAmount, tokenIn, amountIn, Number(expiry), door],
  });

  const [created] = parseEventLogs({
    abi: gantryCoreAbi,
    logs: receipt.logs,
    eventName: "IntentCreated",
  });
  if (!created) throw new Error(`IntentCreated log missing in tx ${receipt.transactionHash}`);
  const intentId = created.args.intentId;

  const row: IntentRow = {
    intent_id: intentId.toLowerCase(),
    merchant_id: merchant.merchantId.toLowerCase(),
    handle: merchant.handle,
    token_in: tokenIn.toLowerCase(),
    amount_in: amountIn.toString(),
    xsgd_amount: xsgdAmount.toString(),
    rate: rate.toString(),
    expiry: Number(expiry),
    door,
    status: "pending",
    valid_before: Number(validBefore),
    created_tx: receipt.transactionHash,
    settle_tx: null,
    created_at: Number(block.timestamp),
  };
  insertIntentRow(row);

  return {
    intentId,
    merchantId: merchant.merchantId,
    handle: merchant.handle,
    tokenIn,
    tokenSymbol: token,
    amountIn: amountIn.toString(),
    xsgdAmount: xsgdAmount.toString(),
    rate: rate.toString(),
    expiry: Number(expiry),
    door: doorToWire(door),
    payTo: config.addresses.gantryCore,
    validAfter: "0",
    validBefore: validBefore.toString(),
    typedData: toWireTypedData({
      domain: tokenDomain(token),
      to: config.addresses.gantryCore,
      value: amountIn,
      validAfter: 0n,
      validBefore,
      nonce: intentId,
    }),
    txHash: receipt.transactionHash,
  };
}

/** Requote = cancel + recreate, never mutation (contract invariant). */
export async function requoteIntent(intentId: Hex): Promise<IntentResponse> {
  const row = getIntentRow(intentId);
  if (!row) {
    throw new ApiError(404, "UnknownIntent", `no cached quote for intent ${intentId}`);
  }
  if (row.status === "settled") {
    throw new ApiError(409, "IntentAlreadySettled", "intent already settled");
  }
  if (row.status === "pending") {
    await sendRelayerTx({
      address: config.addresses.gantryCore,
      abi: gantryCoreAbi,
      functionName: "cancelIntent",
      args: [intentId],
    });
    setIntentStatus(intentId, "cancelled");
  }
  const token = tokenIdByAddress(config.addresses, row.token_in as `0x${string}`);
  return createIntent({
    handle: row.handle,
    xsgdAmount: row.xsgd_amount,
    ...(token ? { token } : {}),
    door: doorToWire(row.door as Door),
  });
}

export async function getIntentStatusResponse(intentId: Hex): Promise<IntentStatusResponse> {
  const row = getIntentRow(intentId);
  const now = Math.floor(Date.now() / 1000);

  if (row) {
    let status: IntentWireStatus = row.status;
    if (status === "pending" && row.expiry < now) status = "expired";
    return {
      intentId,
      status,
      handle: row.handle,
      merchantId: row.merchant_id as Hex,
      tokenIn: row.token_in as `0x${string}`,
      amountIn: row.amount_in,
      xsgdAmount: row.xsgd_amount,
      expiry: row.expiry,
      door: doorToWire(row.door as Door),
      ...(row.settle_tx ? { settleTxHash: row.settle_tx as Hex } : {}),
    };
  }

  // Cache miss — chain is the source of truth. Unknown ids return the zero struct.
  const intent = await publicClient.readContract({
    address: config.addresses.gantryCore,
    abi: gantryCoreAbi,
    functionName: "getIntent",
    args: [intentId],
  });
  const statusMap: Record<number, IntentWireStatus> = {
    [IntentStatus.None]: "unknown",
    [IntentStatus.Pending]: intent.expiry < now ? "expired" : "pending",
    [IntentStatus.Settled]: "settled",
    [IntentStatus.Cancelled]: "cancelled",
  };
  const status = statusMap[intent.status] ?? "unknown";
  if (status === "unknown") return { intentId, status };
  return {
    intentId,
    status,
    merchantId: intent.merchantId,
    tokenIn: intent.tokenIn,
    amountIn: intent.amountIn.toString(),
    xsgdAmount: intent.xsgdAmount.toString(),
    expiry: intent.expiry,
    door: doorToWire(intent.door as Door),
  };
}

/** Signed authorization window for settle — DB fallback when the client omits it. */
export function storedValidBefore(intentId: Hex): number | undefined {
  return getIntentRow(intentId)?.valid_before;
}
