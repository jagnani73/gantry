import { keccak256, toBytes, type Address, type Hex } from "viem";
import {
  Door,
  IntentStatus,
  agentPbmWalletAbi,
  caip2,
  eip3009TokenAbi,
  gantryCoreAbi,
  tokenIdByAddress,
  type X402PaymentPayload,
  type X402PaymentRequirements,
  type X402SupportedResponse,
  type X402VerifyResponse,
} from "@gantry/shared";
import { publicClient, relayerAccount, tokenDomain } from "../chain";
import { config } from "../config";
import { getIntentRow } from "../db";
import { validateExactPayment, type VerifyFailure } from "./facilitator-core";
import { GantryPbmPayloadSchema, validatePbmPayment } from "./pbm-core";

/**
 * The facilitator's verify side. Spec-shaped: payment problems come back as
 * `isValid: false` with an invalidReason — never thrown — because that is how
 * both the @x402 resource server and the HTTP route consume them.
 */

const BALANCE_LAG_RETRIES = 4;
const BALANCE_LAG_DELAY_MS = 1200;

/** A pbm intent must stay alive long enough for the single settle tx behind
 * the FIFO queue — fail a nearly-expired intent fast at verify instead of
 * burning a settle simulation on IntentExpired. */
const PBM_EXPIRY_MARGIN_SECONDS = 30;

export function getSupported(): X402SupportedResponse {
  return {
    kinds: [
      { x402Version: 2, scheme: "exact", network: caip2(config.chainId) },
      { x402Version: 2, scheme: "gantry-pbm", network: caip2(config.chainId) },
    ],
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
  const readBalance = () =>
    publicClient.readContract({
      address: requirements.asset,
      abi: eip3009TokenAbi,
      functionName: "balanceOf",
      args: [authorization.from],
    });
  const [used, firstBalance] = await Promise.all([
    publicClient.readContract({
      address: requirements.asset,
      abi: eip3009TokenAbi,
      functionName: "authorizationState",
      args: [authorization.from, authorization.nonce],
    }),
    readBalance(),
  ]);
  if (used) {
    return {
      isValid: false,
      invalidReason: "authorization_already_used",
      invalidMessage: "authorization nonce already consumed on-chain",
      payer: authorization.from,
    };
  }

  // A just-funded payer (faucet, fresh transfer) can read as broke on a
  // lagging replica — same class M1's settle path retries. Re-read, bounded,
  // before declaring insufficient_funds; the delay only taxes failures.
  let balance = firstBalance;
  for (let attempt = 0; balance < BigInt(authorization.value) && attempt < BALANCE_LAG_RETRIES; attempt++) {
    await new Promise((r) => setTimeout(r, BALANCE_LAG_DELAY_MS));
    balance = await readBalance();
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

export async function verifyPbm(
  payload: X402PaymentPayload,
  requirements: X402PaymentRequirements,
): Promise<X402VerifyResponse> {
  const invalid = (reason: string, message: string, payer?: Address): X402VerifyResponse => ({
    isValid: false,
    invalidReason: reason,
    invalidMessage: message,
    ...(payer ? { payer } : {}),
  });

  if (!tokenIdByAddress(config.addresses, requirements.asset)) {
    return invalid("unknown_asset", `asset ${requirements.asset} is not a listed pay token`);
  }

  // Cheap pre-parse for the wallet address — the full validation re-parses.
  const parsed = GantryPbmPayloadSchema.safeParse(payload.payload);
  if (!parsed.success) {
    return invalid("invalid_payload", "payload is not a {pbmWallet, intentId, signature} gantry-pbm payload");
  }
  const { pbmWallet, intentId } = parsed.data;

  // The signature verifies against the wallet's LIVE agentSigner — a wrong or
  // non-wallet address fails here, before any signature math.
  let agentSigner: Address;
  try {
    agentSigner = await publicClient.readContract({
      address: pbmWallet,
      abi: agentPbmWalletAbi,
      functionName: "agentSigner",
    });
  } catch {
    return invalid("invalid_payload", `${pbmWallet} is not an AgentPBMWallet (agentSigner() unreadable)`);
  }

  const validation = await validatePbmPayment({
    payload,
    requirements,
    expectedNetwork: caip2(config.chainId),
    core: config.addresses.gantryCore,
    agentSigner,
    chainId: config.chainId,
  });
  if (!validation.ok) {
    return invalid(validation.failure.reason, validation.failure.message, pbmWallet);
  }

  const intentFailure = await pbmIntentFailure(intentId, validation.pins, requirements);
  if (intentFailure) {
    return invalid(intentFailure.reason, intentFailure.message, pbmWallet);
  }

  // Single balance read, no lag-retry: the demo wallet is funded at setup time
  // (unlike exact's faucet-just-funded burners), so a shortfall here is real.
  const balance = await publicClient.readContract({
    address: requirements.asset,
    abi: eip3009TokenAbi,
    functionName: "balanceOf",
    args: [pbmWallet],
  });
  if (balance < BigInt(requirements.amount)) {
    return invalid("insufficient_funds", "wallet balance below the required amount", pbmWallet);
  }

  return { isValid: true, payer: pbmWallet };
}

/**
 * The pre-created intent must match the server-pinned order facts — the
 * signature alone binds only (intentId, token, amount), so this is what stops
 * a signed cheap intent from settling an expensive order (or another
 * merchant's). DB-first with a chain fallback: the SQLite cache is disposable
 * and a mid-demo backend restart must not brick verification.
 */
async function pbmIntentFailure(
  intentId: Hex,
  pins: { handle: string; xsgdAmount: bigint },
  requirements: X402PaymentRequirements,
): Promise<VerifyFailure | null> {
  const now = Math.floor(Date.now() / 1000);
  const expectedMerchantId = keccak256(toBytes(pins.handle)).toLowerCase();
  const mismatch = (message: string): VerifyFailure => ({ reason: "intent_mismatch", message });

  const row = getIntentRow(intentId);
  if (row) {
    if (row.status === "settled") {
      return { reason: "intent_already_settled", message: "intent already settled (replay?)" };
    }
    if (row.status === "cancelled") {
      return { reason: "intent_cancelled", message: "intent was cancelled — create a fresh one" };
    }
    if (row.expiry < now + PBM_EXPIRY_MARGIN_SECONDS) {
      return { reason: "intent_expired", message: "intent expired (or expires too soon) — create a fresh one" };
    }
    if (row.door !== Door.Agent) return mismatch("intent is not an Agent-door intent");
    if (row.merchant_id !== expectedMerchantId) return mismatch("intent merchant does not match the order");
    if (row.xsgd_amount !== pins.xsgdAmount.toString()) return mismatch("intent xsgdAmount does not match the order");
    if (row.token_in !== requirements.asset.toLowerCase()) return mismatch("intent token does not match the offer");
    if (row.amount_in !== requirements.amount) {
      return { reason: "quote_changed", message: `intent amountIn ${row.amount_in} != offer ${requirements.amount}` };
    }
    return null;
  }

  const intent = await publicClient.readContract({
    address: config.addresses.gantryCore,
    abi: gantryCoreAbi,
    functionName: "getIntent",
    args: [intentId],
  });
  if (intent.status === IntentStatus.None) {
    return { reason: "unknown_intent", message: "intent does not exist — POST /api/pbm/intent first" };
  }
  if (intent.status === IntentStatus.Settled) {
    return { reason: "intent_already_settled", message: "intent already settled (replay?)" };
  }
  if (intent.status === IntentStatus.Cancelled) {
    return { reason: "intent_cancelled", message: "intent was cancelled — create a fresh one" };
  }
  if (intent.expiry < now + PBM_EXPIRY_MARGIN_SECONDS) {
    return { reason: "intent_expired", message: "intent expired (or expires too soon) — create a fresh one" };
  }
  if (intent.door !== Door.Agent) return mismatch("intent is not an Agent-door intent");
  if (intent.merchantId.toLowerCase() !== expectedMerchantId) return mismatch("intent merchant does not match the order");
  if (intent.xsgdAmount !== pins.xsgdAmount) return mismatch("intent xsgdAmount does not match the order");
  if (intent.tokenIn.toLowerCase() !== requirements.asset.toLowerCase()) {
    return mismatch("intent token does not match the offer");
  }
  if (intent.amountIn.toString() !== requirements.amount) {
    return {
      reason: "quote_changed",
      message: `intent amountIn ${intent.amountIn} != offer ${requirements.amount}`,
    };
  }
  return null;
}
