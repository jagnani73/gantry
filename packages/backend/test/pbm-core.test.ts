import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildSpendAuthorization,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "@gantry/shared";
import { orderPin } from "../src/services/facilitator-core";
import {
  GantryPbmPayloadSchema,
  PBM_EXPIRY_MARGIN_SECONDS,
  pbmIntentMismatch,
  validatePbmPayment,
  type PbmIntentFacts,
} from "../src/services/pbm-core";

/** Pure-module tests (no env/config, facilitator-core.test.ts precedent):
 * the session key signs real typed data so the signature path is exercised
 * end-to-end, not mocked. */

const SESSION_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const sessionAccount = privateKeyToAccount(SESSION_KEY);

const wallet = "0xDD4bbed78B64715288bf10fabB2b62c659299D3E" as const;
const core = "0x6F02501ed28Fe918b04fC285404C615f4Ab25Ce0" as const;
// Opaque fixtures — these matchers compare strings and never resolve an address
// or a price, so neither value needs to track the live token set or the demo.
const token = "0x5F7F058F2B1572524d1E3E740656CfAd1Ab011F9" as const;
const intentId = `0x${"11".repeat(32)}` as const;
const amount = "14529469";
const network = "eip155:84532" as const;

function requirements(overrides: Partial<X402PaymentRequirements> = {}): X402PaymentRequirements {
  const handle = "ah-hock-chicken-rice";
  const xsgdAmount = "19500000";
  return {
    scheme: "gantry-pbm",
    network,
    asset: token,
    amount,
    payTo: core,
    maxTimeoutSeconds: 600,
    extra: {
      name: "Mock USDC",
      version: "1",
      handle,
      xsgdAmount,
      intentEndpoint: "/api/pbm/intent",
      // Order facts are only trusted when this process pinned them — the raw
      // POST /facilitator/settle surface validates requirements by shape alone.
      pin: orderPin({ handle, xsgdAmount, asset: token, amount }),
    },
    ...overrides,
  };
}

async function signSpend(over: { intentId?: `0x${string}`; amount?: bigint } = {}) {
  return sessionAccount.signTypedData(
    buildSpendAuthorization({
      wallet,
      chainId: 84532,
      intentId: over.intentId ?? intentId,
      token,
      amount: over.amount ?? BigInt(amount),
    }),
  );
}

async function payload(
  reqs: X402PaymentRequirements,
  inner?: Record<string, unknown>,
): Promise<X402PaymentPayload> {
  return {
    x402Version: 2,
    accepted: reqs,
    payload: inner ?? { pbmWallet: wallet, intentId, signature: await signSpend() },
  };
}

function inputs(reqs: X402PaymentRequirements, p: X402PaymentPayload) {
  return {
    payload: p,
    requirements: reqs,
    expectedNetwork: network,
    core,
    agentSigner: sessionAccount.address,
    chainId: 84532,
  };
}

test("payload schema accepts the wire shape and rejects malformed fields", async () => {
  const good = { pbmWallet: wallet, intentId, signature: await signSpend() };
  assert.ok(GantryPbmPayloadSchema.safeParse(good).success);
  assert.ok(!GantryPbmPayloadSchema.safeParse({ ...good, signature: "0x1234" }).success);
  assert.ok(!GantryPbmPayloadSchema.safeParse({ ...good, pbmWallet: "not-an-address" }).success);
  assert.ok(!GantryPbmPayloadSchema.safeParse({ pbmWallet: wallet, signature: good.signature }).success);
});

test("happy path validates and returns the server pins", async () => {
  const reqs = requirements();
  const result = await validatePbmPayment(inputs(reqs, await payload(reqs)));
  assert.ok(result.ok);
  assert.equal(result.pbm.pbmWallet, wallet);
  assert.equal(result.pins.handle, "ah-hock-chicken-rice");
  assert.equal(result.pins.xsgdAmount, 19_500_000n);
});

test("wrong scheme and network fail closed", async () => {
  const reqs = requirements();
  const p = await payload(reqs);

  const wrongScheme = await validatePbmPayment(
    inputs({ ...reqs, scheme: "exact" }, { ...p, accepted: { ...reqs, scheme: "exact" } }),
  );
  assert.ok(!wrongScheme.ok && wrongScheme.failure.reason === "unsupported_scheme");

  const wrongNetwork = await validatePbmPayment({
    ...inputs(reqs, p),
    expectedNetwork: "eip155:31337",
  });
  assert.ok(!wrongNetwork.ok && wrongNetwork.failure.reason === "unsupported_network");
});

test("payTo must be the core (non-custodial invariant)", async () => {
  const reqs = requirements({ payTo: sessionAccount.address });
  const result = await validatePbmPayment(inputs(reqs, await payload(reqs)));
  assert.ok(!result.ok && result.failure.reason === "invalid_pay_to");
});

test("missing or invalid extra pins fail as invalid_requirements", async () => {
  const reqs = requirements({ extra: { name: "Mock USDC", version: "1" } });
  const result = await validatePbmPayment(inputs(reqs, await payload(reqs)));
  assert.ok(!result.ok && result.failure.reason === "invalid_requirements");
});

test("non-positive amount fails as invalid_amount", async () => {
  const reqs = requirements({ amount: "0" });
  const result = await validatePbmPayment(inputs(reqs, await payload(reqs)));
  assert.ok(!result.ok && result.failure.reason === "invalid_amount");
});

test("signature by a different key fails as invalid_signature", async () => {
  const reqs = requirements();
  const p = await payload(reqs);
  const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`);
  const result = await validatePbmPayment({ ...inputs(reqs, p), agentSigner: stranger.address });
  assert.ok(!result.ok && result.failure.reason === "invalid_signature");
});

// ---------------------------------------------------------------- intent-vs-pins match
// The security boundary the signature cannot cover: these checks stop a
// signed cheap intent from settling a different merchant's or pricier order.
// Both facilitator loaders (DB row and chain struct) normalize into
// PbmIntentFacts and share this one matcher — the table below covers every
// rejection the live e2e paths never trigger.

const NOW = 1_755_000_000;
const expectedMerchantId = keccak256(toBytes("ah-hock-chicken-rice"));

function intentFacts(overrides: Partial<PbmIntentFacts> = {}): PbmIntentFacts {
  return {
    status: "pending",
    door: 1, // Agent
    merchantId: expectedMerchantId.toLowerCase(),
    tokenIn: token.toLowerCase(),
    amountIn: amount,
    xsgdAmount: 19_500_000n,
    expiry: NOW + 600,
    ...overrides,
  };
}

function mismatchReason(overrides: Partial<PbmIntentFacts>): string | null {
  const pins = { handle: "ah-hock-chicken-rice", xsgdAmount: 19_500_000n };
  const result = pbmIntentMismatch(intentFacts(overrides), pins, requirements(), expectedMerchantId, NOW);
  return result?.reason ?? null;
}

test("matching intent facts pass for both loader shapes", () => {
  assert.equal(mismatchReason({}), null);
  // The chain loader lowercases; the matcher itself must also tolerate a
  // mixed-case expectedMerchantId (it normalizes internally).
  const pins = { handle: "ah-hock-chicken-rice", xsgdAmount: 19_500_000n };
  const mixed = pbmIntentMismatch(
    intentFacts(),
    pins,
    requirements(),
    expectedMerchantId.toUpperCase().replace("0X", "0x"),
    NOW,
  );
  assert.equal(mixed, null);
});

test("consumed or unknown intents are rejected before any fact comparison", () => {
  assert.equal(mismatchReason({ status: "unknown" }), "unknown_intent");
  assert.equal(mismatchReason({ status: "settled" }), "intent_already_settled");
  assert.equal(mismatchReason({ status: "cancelled" }), "intent_cancelled");
  // Status precedence beats fact mismatches: a settled intent for the wrong
  // merchant reports the replay, not the mismatch.
  assert.equal(mismatchReason({ status: "settled", merchantId: "0xdead" }), "intent_already_settled");
});

test("expiry margin boundary: must outlive verification by the margin", () => {
  assert.equal(mismatchReason({ expiry: NOW + PBM_EXPIRY_MARGIN_SECONDS - 1 }), "intent_expired");
  assert.equal(mismatchReason({ expiry: NOW + PBM_EXPIRY_MARGIN_SECONDS }), null);
});

test("every pinned fact is enforced: door, merchant, xsgd, token, amount", () => {
  assert.equal(mismatchReason({ door: 0 }), "intent_mismatch"); // Human intent
  assert.equal(mismatchReason({ merchantId: keccak256(toBytes("gadgethub-sg")).toLowerCase() }), "intent_mismatch");
  assert.equal(mismatchReason({ xsgdAmount: 29_000_000n }), "intent_mismatch");
  assert.equal(mismatchReason({ tokenIn: core.toLowerCase() }), "intent_mismatch");
  assert.equal(mismatchReason({ amountIn: "1" }), "quote_changed");
});

test("signature over tampered intentId or amount fails as invalid_signature", async () => {
  const reqs = requirements();

  const otherIntent = await payload(reqs, {
    pbmWallet: wallet,
    intentId,
    signature: await signSpend({ intentId: `0x${"22".repeat(32)}` }),
  });
  const r1 = await validatePbmPayment(inputs(reqs, otherIntent));
  assert.ok(!r1.ok && r1.failure.reason === "invalid_signature");

  // The signature binds the CHALLENGE amount — a sig over a cheaper amount
  // cannot settle the pinned requirement.
  const cheaper = await payload(reqs, {
    pbmWallet: wallet,
    intentId,
    signature: await signSpend({ amount: 1n }),
  });
  const r2 = await validatePbmPayment(inputs(reqs, cheaper));
  assert.ok(!r2.ok && r2.failure.reason === "invalid_signature");
});
