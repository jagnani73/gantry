import { ContractFunctionExecutionError, keccak256, toBytes, type Address, type Hex } from "viem";
import {
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
import {
  GantryPbmPayloadSchema,
  pbmIntentMismatch,
  validatePbmPayment,
  type PbmIntentFacts,
} from "./pbm-core";

/**
 * The facilitator's verify side. Spec-shaped: payment problems come back as
 * `isValid: false` with an invalidReason — never thrown — because that is how
 * both the @x402 resource server and the HTTP route consume them.
 */

const BALANCE_LAG_RETRIES = 4;
const BALANCE_LAG_DELAY_MS = 1200;

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

  // The signature verifies against the wallet's LIVE agentSigner, and the
  // wallet must be bound to OUR core (a foreign-core wallet would pass every
  // check here and then die at simulation as a confusing NotCore). Chain time
  // rides along for the expiry margin — intent expiries are block timestamps,
  // and a skewed laptop clock must not fail healthy intents.
  let agentSigner: Address;
  let walletCore: Address;
  let chainNow: number;
  try {
    const [signer, core, block] = await Promise.all([
      publicClient.readContract({ address: pbmWallet, abi: agentPbmWalletAbi, functionName: "agentSigner" }),
      publicClient.readContract({ address: pbmWallet, abi: agentPbmWalletAbi, functionName: "CORE" }),
      publicClient.getBlock(),
    ]);
    agentSigner = signer;
    walletCore = core;
    chainNow = Number(block.timestamp);
  } catch (err) {
    // Distinguish "that address is not a wallet" (contract call reverted /
    // returned no data) from a transport flake — misattributing an RPC blip
    // as invalid_payload sends the operator debugging the wrong thing.
    console.error(`pbm verify: wallet read failed for ${pbmWallet}`, err);
    if (err instanceof ContractFunctionExecutionError) {
      return invalid("invalid_payload", `${pbmWallet} is not an AgentPBMWallet (agentSigner()/CORE() unreadable)`);
    }
    return invalid("network_error", "chain read failed during verification; retry shortly");
  }
  if (walletCore.toLowerCase() !== config.addresses.gantryCore.toLowerCase()) {
    return invalid("invalid_payload", `wallet is bound to a different GantryCore (${walletCore})`, pbmWallet);
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

  const intentFailure = await pbmIntentFailure(intentId, validation.pins, requirements, chainNow);
  if (intentFailure) {
    return invalid(intentFailure.reason, intentFailure.message, pbmWallet);
  }

  // Single balance read, no lag-retry: an agent wallet ships EMPTY from
  // DeployPBM.s.sol and is topped up by a relayer transfer that demo-reset makes
  // well before any payment (unlike exact's faucet-just-funded burners, whose
  // grant lands seconds before they sign), so a shortfall here is real.
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
 * Loads the pre-created intent (DB-first; chain fallback so a mid-demo
 * backend restart cannot brick verification), normalizes either shape into
 * PbmIntentFacts, and delegates the actual pins match to the pure, unit-
 * tested pbmIntentMismatch in pbm-core.ts.
 */
async function pbmIntentFailure(
  intentId: Hex,
  pins: { handle: string; xsgdAmount: bigint },
  requirements: X402PaymentRequirements,
  chainNow: number,
): Promise<VerifyFailure | null> {
  const expectedMerchantId = keccak256(toBytes(pins.handle));

  const row = getIntentRow(intentId);
  if (row) {
    const facts: PbmIntentFacts = {
      status: row.status,
      door: row.door,
      merchantId: row.merchant_id,
      tokenIn: row.token_in,
      amountIn: row.amount_in,
      xsgdAmount: BigInt(row.xsgd_amount),
      expiry: row.expiry,
    };
    return pbmIntentMismatch(facts, pins, requirements, expectedMerchantId, chainNow);
  }

  const intent = await publicClient.readContract({
    address: config.addresses.gantryCore,
    abi: gantryCoreAbi,
    functionName: "getIntent",
    args: [intentId],
  });
  const statusMap = {
    [IntentStatus.None]: "unknown",
    [IntentStatus.Pending]: "pending",
    [IntentStatus.Settled]: "settled",
    [IntentStatus.Cancelled]: "cancelled",
  } as const;
  const facts: PbmIntentFacts = {
    status: statusMap[intent.status as keyof typeof statusMap] ?? "unknown",
    door: intent.door,
    merchantId: intent.merchantId.toLowerCase(),
    tokenIn: intent.tokenIn.toLowerCase(),
    amountIn: intent.amountIn.toString(),
    xsgdAmount: intent.xsgdAmount,
    expiry: intent.expiry,
  };
  return pbmIntentMismatch(facts, pins, requirements, expectedMerchantId, chainNow);
}
