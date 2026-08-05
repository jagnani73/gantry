import { test } from "node:test";
import assert from "node:assert/strict";
import { hashTypedData } from "viem";
import {
  buildTransferAuthorization,
  toWireTypedData,
  reviveTypedData,
  type TransferAuthorizationParams,
} from "./eip3009";
import { BASE_SEPOLIA_ADDRESSES } from "./addresses";

const params: TransferAuthorizationParams = {
  domain: {
    name: "USDC",
    version: "2",
    chainId: 84532,
    verifyingContract: BASE_SEPOLIA_ADDRESSES.realUsdc!,
  },
  from: "0x82513007C7eB93b54dC555Bdb74341b3084FC47B",
  to: BASE_SEPOLIA_ADDRESSES.gantryCore,
  value: 4_843_157n,
  validAfter: 0n,
  validBefore: 1_800_000_000n,
  nonce: "0x1111111111111111111111111111111111111111111111111111111111111111",
};

test("wire round-trip preserves the EIP-712 digest", () => {
  const direct = buildTransferAuthorization(params);
  const revived = reviveTypedData(toWireTypedData(params));
  assert.equal(hashTypedData(direct), hashTypedData(revived));
});

test("typed data pins the settlement invariants", () => {
  const td = buildTransferAuthorization(params);
  assert.equal(td.primaryType, "TransferWithAuthorization");
  assert.equal(td.message.to, BASE_SEPOLIA_ADDRESSES.gantryCore);
  assert.equal(td.message.nonce, params.nonce);
  assert.equal(td.message.validAfter, 0n);
  const fields = td.types.TransferWithAuthorization.map((f) => f.name);
  assert.deepEqual(fields, ["from", "to", "value", "validAfter", "validBefore", "nonce"]);
});
