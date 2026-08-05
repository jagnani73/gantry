import { test } from "node:test";
import assert from "node:assert/strict";
import {
  caip2,
  chainIdFromCaip2,
  decodeBase64Json,
  decodePaymentRequiredHeader,
  encodeBase64Json,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  decodePaymentSignatureHeader,
  decodePaymentResponseHeader,
  type X402PaymentPayload,
  type X402SettleResponse,
} from "./x402";
import { BASE_SEPOLIA_ADDRESSES, BASE_SEPOLIA_RELAYER } from "./addresses";

// Captured shape of a real SDK v2 PAYMENT-REQUIRED header (base64 of spec-field
// JSON) — decoding it pins our types to the wire the vanilla client speaks.
const SDK_PAYMENT_REQUIRED_FIXTURE =
  "eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkIiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cDovL2xvY2FsaG9zdDo0MDAwL2FwaS9vcmRlci9haC1ob2NrLWNoaWNrZW4tcmljZT9zZ2Q9Ni41MCIsImRlc2NyaXB0aW9uIjoiR2FudHJ5IG9yZGVyIiwibWltZVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIn0sImFjY2VwdHMiOlt7InNjaGVtZSI6ImV4YWN0IiwibmV0d29yayI6ImVpcDE1NTo4NDUzMiIsImFtb3VudCI6IjQ4NDMxNTYiLCJhc3NldCI6IjB4MDM2Q2JENTM4NDJjNTQyNjYzNGU3OTI5NTQxZUMyMzE4ZjNkQ0Y3ZSIsInBheVRvIjoiMHg4MjUxMzAwN0M3ZUI5M2I1NGRDNTU1QmRiNzQzNDFiMzA4NEZDNDdCIiwibWF4VGltZW91dFNlY29uZHMiOjYwMCwiZXh0cmEiOnsibmFtZSI6IlVTREMiLCJ2ZXJzaW9uIjoiMiJ9fV19";

test("decodes an SDK-shaped PAYMENT-REQUIRED header into owned types", () => {
  const decoded = decodePaymentRequiredHeader(SDK_PAYMENT_REQUIRED_FIXTURE);
  assert.equal(decoded.x402Version, 2);
  assert.equal(decoded.accepts.length, 1);
  const req = decoded.accepts[0]!;
  assert.equal(req.scheme, "exact");
  assert.equal(req.network, "eip155:84532");
  assert.equal(req.amount, "4843156");
  assert.equal(req.asset, BASE_SEPOLIA_ADDRESSES.realUsdc);
  assert.equal(req.payTo, BASE_SEPOLIA_RELAYER);
  assert.equal(req.maxTimeoutSeconds, 600);
  assert.deepEqual(req.extra, { name: "USDC", version: "2" });
  assert.ok(decoded.resource.url.includes("?sgd=6.50"), "query string must survive the wire");
});

test("payment payload and settle response headers roundtrip", () => {
  const payload: X402PaymentPayload = {
    x402Version: 2,
    resource: { url: "http://localhost:4000/api/order/ah-hock-chicken-rice?sgd=6.50" },
    accepted: decodePaymentRequiredHeader(SDK_PAYMENT_REQUIRED_FIXTURE).accepts[0]!,
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: {
        from: BASE_SEPOLIA_RELAYER,
        to: BASE_SEPOLIA_RELAYER,
        value: "4843156",
        validAfter: "0",
        validBefore: "1754380800",
        nonce: "0x" + "11".repeat(32),
      },
    },
  };
  assert.deepEqual(decodePaymentSignatureHeader(encodePaymentSignatureHeader(payload)), payload);

  const settle: X402SettleResponse = {
    success: true,
    payer: BASE_SEPOLIA_RELAYER,
    transaction: "0x" + "22".repeat(32),
    network: "eip155:84532",
    amount: "4843156",
  };
  assert.deepEqual(decodePaymentResponseHeader(encodePaymentResponseHeader(settle)), settle);
});

test("encoder emits standard base64 (the SDK's accepted alphabet)", () => {
  const encoded = encodeBase64Json({ url: "https://a.b/c?d=e&f=g", note: "6.50 S$ ~ ☺" });
  assert.match(encoded, /^[A-Za-z0-9+/]*={0,2}$/);
});

test("decoder rejects non-base64 and URL-safe-alphabet input", () => {
  assert.throws(() => decodeBase64Json("not base64!!"), /invalid base64/);
  assert.throws(() => decodeBase64Json("abc_-def"), /invalid base64/);
  assert.throws(() => decodeBase64Json(encodeBase64Json("just a string").slice(0, 3) + "%"), /invalid base64/);
});

test("caip2 helpers roundtrip and reject non-eip155 networks", () => {
  assert.equal(caip2(84532), "eip155:84532");
  assert.equal(chainIdFromCaip2(caip2(31337)), 31337);
  assert.throws(() => chainIdFromCaip2("solana:mainnet"), /unsupported CAIP-2/);
  assert.throws(() => chainIdFromCaip2("eip155:abc"), /unsupported CAIP-2/);
  // the encoder must never emit what its own inverse rejects
  assert.throws(() => caip2(1.5), /positive integer/);
  assert.throws(() => caip2(0), /positive integer/);
});
