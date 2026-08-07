import { keccak256, toBytes, zeroAddress, type Address, type Hex } from "viem";
import {
  DEMO_MERCHANTS,
  categoryName,
  gantryCoreAbi,
  isKnownCategory,
  isValidHandle,
  type MerchantResponse,
  type RegisterMerchantRequest,
  type RegisterMerchantResponse,
} from "@gantry/shared";
import { publicClient } from "../chain";
import { config } from "../config";
import { ApiError } from "../errors";
import { sendRelayerTx } from "../relayer";

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: MerchantResponse }>();

export function merchantId(handle: string): Hex {
  return keccak256(toBytes(handle));
}

export async function getMerchant(handle: string): Promise<MerchantResponse> {
  if (!isValidHandle(handle)) {
    throw new ApiError(400, "InvalidHandle", `not a valid merchant handle: ${handle}`);
  }
  const cached = cache.get(handle);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const id = merchantId(handle);
  const [payout, categoryId] = (await publicClient.readContract({
    address: config.addresses.gantryCore,
    abi: gantryCoreAbi,
    functionName: "merchants",
    args: [id],
  })) as readonly [Address, number, string];

  if (payout === zeroAddress) {
    throw new ApiError(404, "MerchantNotFound", `no merchant registered for handle: ${handle}`);
  }

  const value = toMerchantResponse(handle, id, payout, categoryId);
  cache.set(handle, { at: Date.now(), value });
  return value;
}

function toMerchantResponse(
  handle: string,
  id: Hex,
  payout: Address,
  categoryId: number,
): MerchantResponse {
  const demo = DEMO_MERCHANTS[handle];
  return {
    handle,
    merchantId: id,
    payout,
    categoryId,
    categoryName: categoryName(categoryId),
    ...(demo ? { displayName: demo.displayName, location: demo.location } : {}),
  };
}

/**
 * Onboarding. `registerMerchant` is permissionless on-chain — anyone can call
 * it with their own gas — so relaying it here is faucet trust level: an
 * unauthenticated request that spends relayer ETH. Guarded the same way as the
 * faucet, with a per-IP cooldown and an ONBOARDING_ENABLED kill switch for
 * public hosts.
 *
 * A taken handle is not pre-checked: sendRelayerTx simulates first, so the
 * duplicate reverts with HandleTaken before any gas is spent and the decoded
 * custom error reaches the client as a 409.
 */
const REGISTER_COOLDOWN_MS = 30_000;
const lastRegister = new Map<string, number>();

export async function registerMerchant(
  req: RegisterMerchantRequest,
  ip: string | undefined,
): Promise<RegisterMerchantResponse> {
  if (!config.onboardingEnabled) {
    throw new ApiError(403, "OnboardingDisabled", "merchant onboarding is disabled here");
  }
  if (!isValidHandle(req.handle)) {
    throw new ApiError(
      400,
      "InvalidHandle",
      "handle must be 1–32 characters of a–z, 0–9 or -, and cannot start or end with -",
    );
  }
  if (!isKnownCategory(req.categoryId)) {
    throw new ApiError(
      400,
      "InvalidCategory",
      `unknown category: ${req.categoryId}`,
      [req.categoryId],
    );
  }

  const key = ip ?? "unknown";
  const last = lastRegister.get(key);
  if (last && Date.now() - last < REGISTER_COOLDOWN_MS) {
    throw new ApiError(429, "OnboardingCooldown", "registration cooldown active — try again shortly");
  }

  const { receipt } = await sendRelayerTx({
    address: config.addresses.gantryCore,
    abi: gantryCoreAbi,
    functionName: "registerMerchant",
    args: [req.handle, req.payout, req.categoryId],
  });
  // Cooldown only after a successful register, so a reverted attempt still
  // surfaces its real error on retry rather than a bogus 429 (faucet precedent).
  lastRegister.set(key, Date.now());

  // Prime the cache so the immediate redirect to /pay/<handle> doesn't race a
  // fresh chain read. Nothing to invalidate: only successful lookups are cached
  // and this handle had none (the 404 path throws before cache.set).
  const value = toMerchantResponse(req.handle, merchantId(req.handle), req.payout, req.categoryId);
  cache.set(req.handle, { at: Date.now(), value });
  return { ...value, txHash: receipt.transactionHash };
}
