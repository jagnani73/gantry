import { keccak256, toBytes, zeroAddress, type Address, type Hex } from "viem";
import {
  DEMO_MERCHANTS,
  categoryName,
  gantryCoreAbi,
  isValidHandle,
  type MerchantResponse,
} from "@gantry/shared";
import { publicClient } from "../chain";
import { config } from "../config";
import { ApiError } from "../errors";

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

  const demo = DEMO_MERCHANTS[handle];
  const value: MerchantResponse = {
    handle,
    merchantId: id,
    payout,
    categoryId,
    categoryName: categoryName(categoryId),
    ...(demo ? { displayName: demo.displayName, location: demo.location } : {}),
  };
  cache.set(handle, { at: Date.now(), value });
  return value;
}
