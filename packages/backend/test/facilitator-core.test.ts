import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import {
  BASE_SEPOLIA_ADDRESSES,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_RELAYER,
  TOKENS,
  buildTransferAuthorization,
  caip2,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "@gantry/shared";
import {
  ExactEvmPayloadSchema,
  VERIFY_MARGIN_SECONDS,
  parseOrderPins,
  parseOrderResource,
  reasonForGantryError,
  splitSignature65,
  validateExactPayment,
  type VerifyInputs,
} from "../src/services/facilitator-core";

const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const NOW = 1_754_000_000;
const domain = {
  ...TOKENS.MUSDC.eip712,
  chainId: BASE_SEPOLIA_CHAIN_ID,
  verifyingContract: BASE_SEPOLIA_ADDRESSES.mockUsdc,
};

const requirements: X402PaymentRequirements = {
  scheme: "exact",
  network: caip2(BASE_SEPOLIA_CHAIN_ID),
  asset: BASE_SEPOLIA_ADDRESSES.mockUsdc,
  amount: "4843156",
  payTo: BASE_SEPOLIA_RELAYER,
  maxTimeoutSeconds: 600,
  extra: { name: TOKENS.MUSDC.eip712.name, version: TOKENS.MUSDC.eip712.version },
};

const authorization = {
  from: payer.address,
  to: BASE_SEPOLIA_RELAYER,
  value: "4843156",
  validAfter: "0",
  validBefore: String(NOW + 600),
  nonce: ("0x" + "11".repeat(32)) as `0x${string}`,
};

const signature = await payer.signTypedData(
  buildTransferAuthorization({
    domain,
    from: authorization.from,
    to: authorization.to,
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce,
  }),
);

function makePayload(overrides?: Partial<typeof authorization>, accepted = requirements): X402PaymentPayload {
  return {
    x402Version: 2,
    resource: { url: "http://localhost:4000/api/order/ah-hock-chicken-rice?sgd=6.50" },
    accepted,
    payload: { signature, authorization: { ...authorization, ...overrides } },
  };
}

function inputs(payload: X402PaymentPayload, over?: Partial<VerifyInputs>): VerifyInputs {
  return {
    payload,
    requirements,
    now: NOW,
    relayer: BASE_SEPOLIA_RELAYER,
    expectedNetwork: caip2(BASE_SEPOLIA_CHAIN_ID),
    domain,
    ...over,
  };
}

async function failureReason(payload: X402PaymentPayload, over?: Partial<VerifyInputs>): Promise<string> {
  const result = await validateExactPayment(inputs(payload, over));
  assert.equal(result.ok, false);
  return result.ok ? "" : result.failure.reason;
}

test("parseOrderResource extracts handle and sgd from a full order URL", () => {
  assert.deepEqual(parseOrderResource("http://localhost:4000/api/order/ah-hock-chicken-rice?sgd=6.50"), {
    handle: "ah-hock-chicken-rice",
    sgd: "6.50",
  });
  // extra query params are tolerated; encoded handle segments decode first
  assert.deepEqual(parseOrderResource("https://api.gantry.sg/api/order/ah%2Dhock?sgd=19.50&note=x"), {
    handle: "ah-hock",
    sgd: "19.50",
  });
});

test("parseOrderResource rejects non-order URLs, bad handles and missing sgd", () => {
  assert.equal(parseOrderResource("not a url"), null);
  assert.equal(parseOrderResource("http://x/api/order/ah-hock/extra?sgd=1"), null);
  assert.equal(parseOrderResource("http://x/api/orders/ah-hock?sgd=1"), null);
  assert.equal(parseOrderResource("http://x/api/order/ah-hock"), null);
  assert.equal(parseOrderResource("http://x/api/order/AH-HOCK?sgd=1"), null, "handle regex is lowercase");
});

test("parseOrderResource rejects non-positive and malformed sgd amounts", () => {
  // reachable by any client; must die here, not inside the quote (div-by-zero 500)
  assert.equal(parseOrderResource("http://x/api/order/ah-hock?sgd=0"), null);
  assert.equal(parseOrderResource("http://x/api/order/ah-hock?sgd=0.00"), null);
  assert.equal(parseOrderResource("http://x/api/order/ah-hock?sgd=abc"), null);
  assert.equal(parseOrderResource("http://x/api/order/ah-hock?sgd=-5"), null);
});

test("parseOrderPins accepts server-pinned facts and rejects tampered shapes", () => {
  assert.deepEqual(
    parseOrderPins({ name: "USDC", version: "2", handle: "ah-hock", xsgdAmount: "19500000" }),
    { handle: "ah-hock", xsgdAmount: 19500000n },
  );
  assert.equal(parseOrderPins({ name: "USDC", version: "2" }), null, "missing pins");
  assert.equal(parseOrderPins({ handle: "AH-HOCK", xsgdAmount: "1" }), null, "invalid handle");
  assert.equal(parseOrderPins({ handle: "ah-hock", xsgdAmount: "0" }), null, "zero amount");
  assert.equal(parseOrderPins({ handle: "ah-hock", xsgdAmount: "19.50" }), null, "not 6dp units");
  assert.equal(parseOrderPins({ handle: "ah-hock", xsgdAmount: 19500000 }), null, "number, not string");
});

test("splitSignature65 normalizes both v and yParity final bytes", () => {
  const real = splitSignature65(signature);
  assert.ok(real.v === 27 || real.v === 28, `expected 27/28, got ${real.v}`);
  const body = signature.slice(0, -2);
  const y0 = splitSignature65(`${body}00` as `0x${string}`);
  const y1 = splitSignature65(`${body}01` as `0x${string}`);
  assert.equal(y0.v, 27);
  assert.equal(y1.v, 28);
  assert.equal(y0.r, real.r);
  assert.equal(y0.s, real.s);
});

test("payload schema accepts the vanilla client shape and rejects malformed ones", () => {
  assert.ok(ExactEvmPayloadSchema.safeParse({ signature, authorization }).success);
  assert.ok(!ExactEvmPayloadSchema.safeParse({ signature: signature.slice(0, -2), authorization }).success);
  assert.ok(!ExactEvmPayloadSchema.safeParse({ signature, authorization: { ...authorization, value: "6.50" } }).success);
  assert.ok(!ExactEvmPayloadSchema.safeParse({ authorization }).success);
});

test("a correctly signed vanilla payload validates", async () => {
  const result = await validateExactPayment(inputs(makePayload()));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.exact.authorization.from, payer.address);
});

test("time-window checks pass exactly at their boundaries", async () => {
  // an >= / > drift here would reject payments signed at the margin — a case
  // e2e can never reproduce deliberately
  const auth = {
    ...authorization,
    validAfter: String(NOW),
    validBefore: String(NOW + VERIFY_MARGIN_SECONDS),
  };
  const sig = await payer.signTypedData(
    buildTransferAuthorization({
      domain,
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    }),
  );
  const payload: X402PaymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: { signature: sig, authorization: auth },
  };
  const result = await validateExactPayment(inputs(payload));
  assert.equal(result.ok, true);
});

test("each protocol failure maps to its reason, first failure wins", async () => {
  assert.equal(await failureReason(makePayload(undefined, { ...requirements, scheme: "upto" })), "unsupported_scheme");
  assert.equal(
    await failureReason(makePayload(undefined, { ...requirements, network: "eip155:1" })),
    "unsupported_network",
  );
  assert.equal(
    await failureReason({ ...makePayload(), payload: { garbage: true } }),
    "invalid_payload",
  );
  assert.equal(
    await failureReason(makePayload(), { requirements: { ...requirements, amount: "abc" } }),
    "invalid_amount",
    "malformed requirements.amount must fail in-band, not throw",
  );
  assert.equal(await failureReason(makePayload({ to: payer.address })), "invalid_pay_to");
  assert.equal(await failureReason(makePayload(), { relayer: payer.address }), "invalid_pay_to");
  assert.equal(await failureReason(makePayload({ value: "4843157" })), "invalid_amount");
  assert.equal(await failureReason(makePayload({ validAfter: String(NOW + 10) })), "authorization_not_yet_valid");
  assert.equal(
    await failureReason(makePayload({ validBefore: String(NOW + VERIFY_MARGIN_SECONDS - 1) })),
    "authorization_expired",
  );
  // untampered fields but a different signer's key ⇒ recovery mismatch
  assert.equal(await failureReason(makePayload({ from: BASE_SEPOLIA_RELAYER })), "invalid_signature");
  // tampered domain (client lied about extra) ⇒ recovery mismatch, not a crash
  assert.equal(
    await failureReason(makePayload(), { domain: { ...domain, name: "Tampered" } }),
    "invalid_signature",
  );
});

test("reasonForGantryError passes custom names through and maps Circle strings", () => {
  assert.equal(reasonForGantryError({ kind: "custom", name: "IntentExpired", args: [] }), "IntentExpired");
  assert.equal(reasonForGantryError({ kind: "custom", name: "CategoryNotAllowed", args: [2] }), "CategoryNotAllowed");
  assert.equal(
    reasonForGantryError({ kind: "string", reason: "FiatTokenV2: authorization is used or canceled" }),
    "authorization_already_used",
  );
  assert.equal(reasonForGantryError({ kind: "string", reason: "FiatTokenV2: caller must be the payee" }), "settlement_failed");
  assert.equal(reasonForGantryError({ kind: "unknown", message: "0xdeadbeef" }), "settlement_failed");
});
