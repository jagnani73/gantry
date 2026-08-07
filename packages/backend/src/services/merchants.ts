import { keccak256, toBytes, zeroAddress, type Address, type Hex } from "viem";
import {
  DEMO_MERCHANTS,
  categoryName,
  gantryCoreAbi,
  isKnownCategory,
  isValidHandle,
  normalizePayout,
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
/**
 * Bounds CONCURRENT registrations per IP. The cooldown alone only rate-limits
 * strictly serial requests, because it is recorded after the tx confirms — so N
 * parallel requests all pass that check and enqueue N registrations against the
 * relayer, which holds the only gas key every door in the system depends on.
 */
const registerInFlight = new Set<string>();

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
    throw new ApiError(400, "InvalidCategory", `unknown category: ${req.categoryId}`, [
      req.categoryId,
    ]);
  }
  // EIP-55, not just hex shape: setMerchantPayout is gated on the payout address
  // itself, so a mistyped-but-well-formed address is unfixable by anyone.
  const payout = normalizePayout(req.payout);
  if (!payout.ok) {
    throw new ApiError(400, "InvalidPayout", payout.message, [payout.reason]);
  }

  const key = ip ?? "unknown";
  const last = lastRegister.get(key);
  if (last && Date.now() - last < REGISTER_COOLDOWN_MS) {
    throw new ApiError(429, "OnboardingCooldown", "registration cooldown active — try again shortly");
  }
  if (registerInFlight.has(key)) {
    throw new ApiError(429, "OnboardingInProgress", "a registration from this address is already in flight");
  }

  registerInFlight.add(key);
  try {
    const { receipt } = await sendRelayerTx({
      address: config.addresses.gantryCore,
      abi: gantryCoreAbi,
      functionName: "registerMerchant",
      args: [req.handle, payout.address, req.categoryId],
    });
    // Cooldown only after a successful register, so a reverted attempt still
    // surfaces its real error on retry rather than a bogus 429 (faucet precedent).
    lastRegister.set(key, Date.now());
    console.log(
      `registered ${req.handle} → ${payout.address} (category ${req.categoryId}) in ${receipt.transactionHash}`,
    );
    return { ...primeCache(req.handle, payout.address, req.categoryId), txHash: receipt.transactionHash, alreadyRegistered: false };
  } catch (err) {
    // Never assume "the relayer helper threw ⇒ the tx did not happen" — the
    // receipt wait caps at 20s, and a register that mines just past it would
    // otherwise come back to its own owner as "that handle is taken, pick
    // another". Prove the outcome on-chain first, as bridge.ts and pbm.ts do.
    if (await ownsHandle(req.handle, payout.address)) {
      console.warn(
        `register for ${req.handle} reported a failure but the handle is on-chain ` +
          `pointing at ${payout.address} — treating as already registered`,
      );
      lastRegister.set(key, Date.now());
      return { ...primeCache(req.handle, payout.address, req.categoryId), txHash: null, alreadyRegistered: true };
    }
    console.error(`register failed for ${req.handle} (payout ${payout.address}):`, err);
    throw err;
  } finally {
    registerInFlight.delete(key);
  }
}

/**
 * Did this registration actually land, whatever the relayer reported? Reads the
 * registry directly — the only honest answer. Fails closed: a failed probe
 * reports the original error rather than claiming a registration succeeded.
 */
async function ownsHandle(handle: string, payout: Address): Promise<boolean> {
  try {
    const [onChainPayout] = (await publicClient.readContract({
      address: config.addresses.gantryCore,
      abi: gantryCoreAbi,
      functionName: "merchants",
      args: [merchantId(handle)],
    })) as readonly [Address, number, string];
    return onChainPayout.toLowerCase() === payout.toLowerCase();
  } catch (probeErr) {
    console.error(`ownership probe for ${handle} failed:`, probeErr);
    return false;
  }
}

/** Prime the 60s cache so the immediate redirect to /pay/<handle> doesn't race a
 * fresh chain read. Nothing to invalidate: only successful lookups are cached
 * and this handle had none (the 404 path throws before cache.set). */
function primeCache(handle: string, payout: Address, categoryId: number): MerchantResponse {
  const value = toMerchantResponse(handle, merchantId(handle), payout, categoryId);
  cache.set(handle, { at: Date.now(), value });
  return value;
}
