import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

import { normalizeProfile, type MerchantProfile } from "./profile";
import {
  PROOF_SKEW_SECONDS,
  PROOF_TTL_SECONDS,
  buildProfileEdit,
  isProofFresh,
  recoverProfileEditSigner,
  type ProfileEditParams,
} from "./profileProof";

/**
 * What this pins is the ONE thing standing between a stranger and every shop
 * name on the rail. `setMerchantProfile` is `onlyRelayer`, so the contract
 * cannot check who asked and the backend's comparison against the payout is the
 * whole control — which makes "does a tampered field recover a different
 * address" a correctness test rather than a formality.
 *
 * There is no cross-stack vector here, unlike agentPolicy.test.ts: nothing
 * verifies this digest in Solidity. The requirement is only that the browser and
 * the backend build it identically, and they do that by both importing the
 * builder tested below.
 */

/** Anvil's first account. A published key, deliberately: this signs test vectors. */
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const account = privateKeyToAccount(KEY);

const MERCHANT_ID = "0x5f2b4e8a3c1d7f6091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708" as Hex;
const GANTRY_CORE = "0xE6289ceA9232af61d7e4F30A67a848c0C322cc93" as Address;
const CHAIN_ID = 84532;
const ISSUED_AT = 1_755_772_800;

const PROFILE: MerchantProfile = {
  displayName: "Ah Hock Chicken Rice",
  location: "Maxwell Food Centre",
  blurb: "Hainanese chicken rice, kopi and iced tea since 1987.",
};

function params(overrides: Partial<ProfileEditParams> = {}): ProfileEditParams {
  return {
    merchantId: MERCHANT_ID,
    profile: PROFILE,
    issuedAt: ISSUED_AT,
    chainId: CHAIN_ID,
    gantryCore: GANTRY_CORE,
    ...overrides,
  };
}

async function sign(p: ProfileEditParams): Promise<Hex> {
  return account.signTypedData(buildProfileEdit(p));
}

test("a signature by the payout recovers that address", async () => {
  const signature = await sign(params());
  const recovered = await recoverProfileEditSigner({ ...params(), signature });
  assert.equal(recovered, account.address);
});

/**
 * The four tamper cases. Each one is a way the backend could be handed a
 * genuine signature over DIFFERENT facts than the ones it is about to write, so
 * each must land somewhere other than the payout — which is what makes the
 * comparison in `updateMerchantProfile` sufficient on its own.
 */
for (const [what, mutated] of [
  ["displayName", params({ profile: { ...PROFILE, displayName: "Ah Hock Chicken Rice " } })],
  ["location", params({ profile: { ...PROFILE, location: "Sim Lim Square" } })],
  ["blurb", params({ profile: { ...PROFILE, blurb: "Cables and chargers." } })],
  ["merchantId", params({ merchantId: `0x${"11".repeat(32)}` as Hex })],
  ["issuedAt", params({ issuedAt: ISSUED_AT + 1 })],
] as const) {
  test(`a tampered ${what} recovers a different address`, async () => {
    const signature = await sign(params());
    const recovered = await recoverProfileEditSigner({ ...mutated, signature });
    assert.notEqual(
      recovered,
      account.address,
      `tampering with ${what} must not still recover the payout`,
    );
  });
}

/**
 * The domain is the free half of the binding: a signature taken from one
 * deployment must not be replayable against another. Both halves matter — a
 * redeploy moves `verifyingContract`, and a fork moves `chainId`.
 */
test("a signature does not carry across deployments", async () => {
  const signature = await sign(params());

  const otherCore = await recoverProfileEditSigner({
    ...params({ gantryCore: "0x9e51484b1B79bB3E9EaCEfB3D3510Cc19b7Baac1" as Address }),
    signature,
  });
  assert.notEqual(otherCore, account.address, "another GantryCore must not accept it");

  const otherChain = await recoverProfileEditSigner({ ...params({ chainId: 1 }), signature });
  assert.notEqual(otherChain, account.address, "another chain must not accept it");
});

/**
 * Both sides hash the value `normalizeProfile` returned rather than raw input,
 * so the browser signing `normalize(draft)` and the backend verifying
 * `normalize(body)` only agree if a second pass is a no-op. It trims and nothing
 * else, but that is a property this depends on rather than an implementation
 * detail it may ignore.
 */
test("normalizeProfile is idempotent, so both sides hash the same bytes", () => {
  const once = normalizeProfile({
    displayName: "  Ah Hock Chicken Rice  ",
    location: "\tMaxwell Food Centre\n",
    blurb: " Since 1987. ",
  });
  assert.ok(once.ok);
  const twice = normalizeProfile(once.value);
  assert.ok(twice.ok);
  assert.deepEqual(twice.value, once.value);
});

test("freshness accepts a proof inside the window and refuses a stale one", () => {
  const now = 1_755_772_800;
  assert.equal(isProofFresh(now, now), true);
  assert.equal(isProofFresh(now - PROOF_TTL_SECONDS, now), true, "the boundary is inclusive");
  assert.equal(isProofFresh(now - PROOF_TTL_SECONDS - 1, now), false);
});

/**
 * `issuedAt` comes off the SIGNER's clock and is checked against the server's,
 * so a device running slightly fast must not have every save refused for a
 * reason invisible at both ends.
 */
test("freshness tolerates a fast client clock but not an arbitrary future stamp", () => {
  const now = 1_755_772_800;
  assert.equal(isProofFresh(now + PROOF_SKEW_SECONDS, now), true);
  assert.equal(isProofFresh(now + PROOF_SKEW_SECONDS + 1, now), false);
});

test("freshness refuses a non-finite stamp rather than comparing with NaN", () => {
  const now = 1_755_772_800;
  assert.equal(isProofFresh(Number.NaN, now), false);
  assert.equal(isProofFresh(Number.POSITIVE_INFINITY, now), false);
});
