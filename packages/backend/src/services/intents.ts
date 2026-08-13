import { parseEventLogs, type Hex } from "viem";
import {
  Door,
  IntentStatus,
  checksummed,
  doorToWire,
  fixedRateSwapAbi,
  gantryCoreAbi,
  isPayableToken,
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
import { config, INTENT_TTL_SECONDS } from "../config";
import { getIntentRow, insertIntentRow, type IntentRow } from "../db";
import { ApiError } from "../errors";
import { sendRelayerTx } from "../relayer";
import { getMerchant } from "./merchants";

const XSGD_IDENTITY_RATE = 1_000_000n;
/** Signature window = quote TTL + slack. The raw EIP-3009 sig is replayable
 * straight to the token until validBefore, so a tight window bounds the
 * known front-run exposure. */
const AUTH_WINDOW_SLACK_SECONDS = 120;

export async function readRate(token: TokenId): Promise<bigint> {
  if (token === "MockXSGD") return XSGD_IDENTITY_RATE;
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

/** `door` is caller-derived from the route, never client-supplied: the QR/payer
 * routes create Human intents; the x402 facilitator bridge and the gantry-pbm
 * pre-signing route (POST /api/pbm/intent) create Agent ones. */
export async function createIntent(
  req: CreateIntentRequest,
  door: Door = Door.Human,
): Promise<IntentResponse> {
  const merchant = await getMerchant(req.handle);

  if (!/^\d+$/.test(req.xsgdAmount)) {
    throw new ApiError(400, "ValidationError", "xsgdAmount must be a decimal string of 6dp units");
  }
  const xsgdAmount = BigInt(req.xsgdAmount);
  if (xsgdAmount <= 0n) {
    throw new ApiError(400, "ValidationError", "xsgdAmount must be positive");
  }

  const token = req.token;
  // Defence in depth behind the route schema. Every caller-choosable token
  // arrives on the unauthenticated POST /api/intents, and MockXSGD's mint() is
  // public — quoting it would let anyone settle a fabricated payment onto a
  // merchant's live book for free. Enforced here as well so a future route
  // cannot reopen the path by forgetting which enum to validate against.
  if (!isPayableToken(token)) {
    throw new ApiError(400, "TokenUnsupported", `${token} cannot be used to pay`);
  }
  const tokenIn = tokenAddress(config.addresses, token);
  const rate = await readRate(token);
  const amountIn = token === "MockXSGD" ? xsgdAmount : quoteAmountIn(xsgdAmount, rate);

  // Chain time, not server clock — a skewed laptop otherwise mints born-expired intents.
  const block = await publicClient.getBlock();
  const expiry = block.timestamp + BigInt(INTENT_TTL_SECONDS);
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

/**
 * Requote = recreate, never mutation (contract invariant).
 *
 * This deliberately does NOT cancel the superseded intent, and that is a
 * security property rather than an omission. `GantryCore.cancelIntent` is
 * `onlyRelayer` — cancellation is not permissionless on-chain — but this route
 * is unauthenticated and takes only an intentId, which `IntentCreated` publishes
 * to the world the moment the intent mines. Cancelling here lent that
 * `onlyRelayer` capability to anyone watching the chain: subscribe to
 * `IntentCreated`, POST the requote, and the payer's already-signed
 * authorization dies on `assertNotReplayed` before it can settle. The payer page
 * has no silent auto-requote — just a manual "Try again" — so the attacker
 * cancels the replacement too, and no human-door payment on this host completes.
 *
 * Doing nothing is correct because the superseded intent expires by itself
 * inside its 600s TTL, and stored statuses are only pending/settled/cancelled
 * with expiry computed, so a lingering `pending` row needs no cleanup.
 *
 * A local-only `setIntentStatus(intentId, "cancelled")` is NOT an acceptable
 * substitute: `assertNotReplayed` reads that status, so an anonymous caller
 * could still 409 the payer's settle — the same denial, merely invisible on
 * chain. If prompt cancellation is ever wanted back, it needs proof the caller
 * owns the intent, not a cheaper way to reach the same relayer key.
 */
export async function requoteIntent(intentId: Hex): Promise<IntentResponse> {
  const row = getIntentRow(intentId);
  if (!row) {
    throw new ApiError(404, "UnknownIntent", `no cached quote for intent ${intentId}`);
  }
  if (row.status === "settled") {
    // With the hash, exactly as settlement.ts's replay guard does. A requote is
    // what the payer's "try again" button calls, and its 409 handler renders a
    // receipt from `args.txHash` — without it, a payment that already landed
    // comes back to its own payer as a failure while the merchant's dashboard
    // chimes.
    throw new ApiError(409, "IntentAlreadySettled", "intent already settled", {
      txHash: row.settle_tx,
    });
  }
  // A requote must reuse the ORIGINAL token. Falling back to a default here
  // would silently requote in a different asset than the payer first saw.
  const token = tokenIdByAddress(config.addresses, row.token_in as `0x${string}`);
  if (!token) {
    throw new ApiError(
      500,
      "UnknownIntentToken",
      `stored intent ${intentId} references an unrecognised token ${row.token_in}`,
    );
  }
  return createIntent(
    {
      handle: row.handle,
      xsgdAmount: row.xsgd_amount,
      token,
    },
    row.door as Door,
  );
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
      // Checksummed, so the cached answer matches both the chain fallback below
      // and what `createIntent` returned for this same id — the store lowercases
      // on write and one field must not read two ways.
      tokenIn: checksummed(row.token_in),
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
