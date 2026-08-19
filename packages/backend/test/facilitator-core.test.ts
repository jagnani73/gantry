import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  orderPin,
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
  ...TOKENS.USDC.eip712,
  chainId: BASE_SEPOLIA_CHAIN_ID,
  verifyingContract: BASE_SEPOLIA_ADDRESSES.realUsdc,
};

const requirements: X402PaymentRequirements = {
  scheme: "exact",
  network: caip2(BASE_SEPOLIA_CHAIN_ID),
  asset: BASE_SEPOLIA_ADDRESSES.realUsdc,
  amount: "4843156",
  payTo: BASE_SEPOLIA_RELAYER,
  maxTimeoutSeconds: 600,
  extra: { name: TOKENS.USDC.eip712.name, version: TOKENS.USDC.eip712.version },
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

test("the pay link parses to the SAME order as the agent endpoint", () => {
  // Both doors must price one order identically — a divergence here would let
  // the human link and the machine link disagree about what the shop charges,
  // which is the single claim the link exists to make.
  const viaAgentDoor = parseOrderResource("http://localhost:4000/api/order/ah-hock-chicken-rice?sgd=4.50");
  const viaPayLink = parseOrderResource("http://localhost:4000/pay/ah-hock-chicken-rice?sgd=4.50");
  assert.deepEqual(viaPayLink, { handle: "ah-hock-chicken-rice", sgd: "4.50" });
  assert.deepEqual(viaPayLink, viaAgentDoor);
});

test("the pay link inherits every order-URL rejection", () => {
  // Same validation, not a second lenient path: `/pay` is reachable by anyone.
  assert.equal(parseOrderResource("http://x/pay/ah-hock/extra?sgd=1"), null);
  assert.equal(parseOrderResource("http://x/payments/ah-hock?sgd=1"), null);
  assert.equal(parseOrderResource("http://x/pay/AH-HOCK?sgd=1"), null);
  assert.equal(parseOrderResource("http://x/pay/ah-hock?sgd=0"), null);
  assert.equal(parseOrderResource("http://x/pay/ah-hock?sgd=-5"), null);
  // No amount is NOT an order — it is the amount-less human link, which the
  // route answers with the payer app rather than with a challenge.
  assert.equal(parseOrderResource("http://x/pay/ah-hock"), null);
});

test("parseOrderResource rejects non-positive and malformed sgd amounts", () => {
  // reachable by any client; must die here, not inside the quote (div-by-zero 500)
  assert.equal(parseOrderResource("http://x/api/order/ah-hock?sgd=0"), null);
  assert.equal(parseOrderResource("http://x/api/order/ah-hock?sgd=0.00"), null);
  assert.equal(parseOrderResource("http://x/api/order/ah-hock?sgd=abc"), null);
  assert.equal(parseOrderResource("http://x/api/order/ah-hock?sgd=-5"), null);
});

const REQ = { asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "14529456" };
/** Requirements as this server would have issued them. */
const pinned = (handle: string, xsgdAmount: string, req = REQ) => ({
  name: "USDC",
  version: "2",
  handle,
  xsgdAmount,
  pin: orderPin({ handle, xsgdAmount, asset: req.asset, amount: req.amount }),
});

test("parseOrderPins accepts server-pinned facts and rejects tampered shapes", () => {
  assert.deepEqual(parseOrderPins(pinned("ah-hock", "19500000"), REQ), {
    handle: "ah-hock",
    xsgdAmount: 19500000n,
  });
  assert.equal(parseOrderPins({ name: "USDC", version: "2" }, REQ), null, "missing pins");
  assert.equal(parseOrderPins(pinned("AH-HOCK", "1"), REQ), null, "invalid handle");
  assert.equal(parseOrderPins(pinned("ah-hock", "0"), REQ), null, "zero amount");
  assert.equal(parseOrderPins(pinned("ah-hock", "19.50"), REQ), null, "not 6dp units");
  assert.equal(
    parseOrderPins({ ...pinned("ah-hock", "19500000"), xsgdAmount: 19500000 }, REQ),
    null,
    "number, not string",
  );
});

test("parseOrderPins refuses order facts this server did not issue", () => {
  // POST /facilitator/settle takes requirements straight from the request body
  // and validates only their shape. On `exact` the custodial hop makes payTo the
  // relayer for every order, so the payer's signature commits to an amount and a
  // collector but never to a shop -- extra.handle is the only thing naming the
  // merchant, and without the pin a caller could name any of them.
  assert.equal(
    parseOrderPins({ name: "USDC", version: "2", handle: "ah-hock", xsgdAmount: "19500000" }, REQ),
    null,
    "no pin at all",
  );
  assert.equal(
    parseOrderPins({ ...pinned("ah-hock", "19500000"), pin: "0".repeat(64) }, REQ),
    null,
    "forged pin",
  );
  // The redirect the pin exists to stop: keep a genuine pin, swap the merchant.
  assert.equal(
    parseOrderPins({ ...pinned("ah-hock", "19500000"), handle: "gadgethub-sg" }, REQ),
    null,
    "handle swapped under a valid pin",
  );
  assert.equal(
    parseOrderPins({ ...pinned("ah-hock", "19500000"), xsgdAmount: "1" }, REQ),
    null,
    "amount swapped under a valid pin",
  );
  // The pin binds the QUOTE too, so a pin issued for one price cannot be
  // replayed against requirements naming another.
  assert.equal(
    parseOrderPins(pinned("ah-hock", "19500000"), { ...REQ, amount: "1" }),
    null,
    "replayed against a different amount",
  );
  assert.equal(
    parseOrderPins(pinned("ah-hock", "19500000"), { ...REQ, asset: `0x${"ab".repeat(20)}` }),
    null,
    "replayed against a different asset",
  );
});

test("orderPin is deterministic, which buildOrderPrice requires", () => {
  // The middleware rebuilds requirements for the paid retry and deep-equal
  // matches them against what the client echoed. A digest carrying a timestamp
  // or a nonce would differ on the rebuild and fail every payment.
  const facts = { handle: "ah-hock", xsgdAmount: "19500000", ...REQ };
  assert.equal(orderPin(facts), orderPin(facts));
  // Case-insensitive on the asset only: addresses arrive in mixed EIP-55 casing.
  assert.equal(orderPin(facts), orderPin({ ...facts, asset: REQ.asset.toLowerCase() }));
  assert.notEqual(orderPin(facts), orderPin({ ...facts, handle: "gadgethub-sg" }));
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

/**
 * The two verify-stage refusals whose CODE is the whole message.
 *
 * A verify-stage refusal re-challenges, and the x402 re-challenge carries only
 * the reason — our prose does not survive the SDK. So collapsing either of
 * these into the generic `invalid_payload` reaches the agent's operator as
 * "payment rejected at verify (status 402)" and names nothing, while every
 * suite stays green. Read off the source because the branch itself is in the
 * chain-touching half; what is pinned is that the literal is still there.
 */
test("a currency mismatch and an unknown asset keep their own reason codes", () => {
  const facilitator = readFileSync(new URL("../src/services/facilitator.ts", import.meta.url), "utf8");
  assert.match(facilitator, /invalid\("agent_currency_mismatch"/);
  assert.match(facilitator, /invalid\("unknown_asset"/);
  // And the guard that produces it is the shared one, so the door and the
  // display can never disagree about what an agent's currency is.
  assert.match(facilitator, /canAgentSpend\(/);
});
