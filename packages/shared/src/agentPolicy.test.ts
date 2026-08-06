import { test } from "node:test";
import assert from "node:assert/strict";
import { hashTypedData } from "viem";
import {
  buildSpendAuthorization,
  toWireSpendAuthorization,
  reviveSpendAuthorization,
  type SpendAuthorizationParams,
} from "./agentPolicy";
import { BASE_SEPOLIA_ADDRESSES } from "./addresses";

const params: SpendAuthorizationParams = {
  wallet: BASE_SEPOLIA_ADDRESSES.demoAgentPbmWallet!,
  chainId: 84532,
  intentId: "0x1111111111111111111111111111111111111111111111111111111111111111",
  token: BASE_SEPOLIA_ADDRESSES.mockUsdc,
  amount: 14_529_469n, // the S$19.50 team lunch
};

test("wire round-trip preserves the EIP-712 digest", () => {
  const direct = buildSpendAuthorization(params);
  const revived = reviveSpendAuthorization(toWireSpendAuthorization(params));
  assert.equal(hashTypedData(direct), hashTypedData(revived));
});

test("server wire form omits verifyingContract; client must supply the wallet", () => {
  const { wallet, ...rest } = params;
  const wire = toWireSpendAuthorization(rest);
  assert.equal(wire.domain.verifyingContract, undefined);
  const revived = reviveSpendAuthorization(wire, wallet);
  assert.equal(hashTypedData(revived), hashTypedData(buildSpendAuthorization(params)));
  assert.throws(() => reviveSpendAuthorization(wire));
});

test("typed data pins the on-chain encoding invariants", () => {
  const td = buildSpendAuthorization(params);
  assert.equal(td.primaryType, "SpendAuthorization");
  assert.equal(td.domain.name, "AgentPBMWallet");
  assert.equal(td.domain.version, "1");
  const fields = td.types.SpendAuthorization.map((f) => f.name);
  assert.deepEqual(fields, ["intentId", "token", "amount"]);
});

test("cross-stack digest vector matches the Foundry suite", () => {
  // The same vector is pinned in packages/contracts test_crossStack_digestVector
  // against the LIVE contract's DOMAIN_SEPARATOR + typehash. If either side's
  // EIP-712 encoding drifts a single byte, one of the two pins goes red —
  // instead of every signature silently dying on-chain as InvalidAgentSignature.
  assert.equal(
    hashTypedData(buildSpendAuthorization(params)),
    "0x1439a3cfe932d4b48486959d9c4faa8f9a9dd806a343f74bc96f44bfe2b29285",
  );
});
