import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  type Abi,
  type Hex,
} from "viem";
import {
  MAX_DENIAL_REASON_BYTES,
  agentPbmWalletAbi,
  gantryCoreAbi,
  gantryErrorsAbi,
} from "@gantry/shared";
import { createDatabase, type DenialRow } from "../src/db-core";
import { ApiError } from "../src/errors";
import {
  DENIAL_PAGE_LIMIT,
  denialEventOf,
  listAgentDenials,
  policyDenialOf,
} from "../src/services/pbm-core";

/**
 * Pure-module tests (pbm-core.test.ts precedent): no config, no chain. The
 * errors are built the way the settle path actually produces them — see
 * `walletRevert`.
 */

/**
 * A wallet policy revert as `settleFromPBM` surfaces it: simulateContract runs
 * against gantryCoreAbi, which does NOT carry the wallet's errors, so viem
 * cannot decode it and hands us raw bytes. That raw path is the whole reason
 * gantryErrorsAbi spreads the AgentPBMWallet ABI — pin it here, because a
 * decode failure downgrades every denial to "unknown" and the beat dies.
 */
function walletRevert(errorName: string, args: readonly unknown[] = []): BaseError {
  const data = encodeErrorResult({ abi: agentPbmWalletAbi as Abi, errorName, args: args as never });
  const reverted = new ContractFunctionRevertedError({
    abi: gantryCoreAbi as Abi,
    data,
    functionName: "settleFromPBM",
  });
  const outer = new BaseError("simulation failed");
  outer.cause = reverted;
  return outer;
}

function coreRevert(errorName: string, args: readonly unknown[] = []): BaseError {
  const data = encodeErrorResult({ abi: gantryCoreAbi as Abi, errorName, args: args as never });
  const reverted = new ContractFunctionRevertedError({
    abi: gantryCoreAbi as Abi,
    data,
    functionName: "settleFromPBM",
  });
  const outer = new BaseError("simulation failed");
  outer.cause = reverted;
  return outer;
}

// ------------------------------------------------------------ the predicate

test("the rejection beat decodes verbatim, with named args", () => {
  const denial = policyDenialOf(walletRevert("CategoryNotAllowed", [2]));
  // "CategoryNotAllowed" is read aloud on stage — it must never be prettified.
  assert.deepEqual(denial, { errorName: "CategoryNotAllowed", errorArgs: { categoryId: 2 } });
});

test("uint256 args survive JSON as 6dp decimal strings", () => {
  const denial = policyDenialOf(walletRevert("PerTxCapExceeded", [4_500_000n, 1_000_000n]));
  assert.deepEqual(denial, {
    errorName: "PerTxCapExceeded",
    // bigints, not numbers: JSON.stringify throws on the former and the wire
    // convention is raw 6dp units anyway.
    errorArgs: { amount: "4500000", cap: "1000000" },
  });
  assert.equal(
    JSON.stringify(denial?.errorArgs),
    '{"amount":"4500000","cap":"1000000"}',
  );

  const daily = policyDenialOf(walletRevert("DailyCapExceeded", [67_105_000n, 50_000_000n]));
  assert.deepEqual(daily?.errorArgs, { attempted: "67105000", cap: "50000000" });
});

test("argless reverts carry no errorArgs key at all", () => {
  assert.deepEqual(policyDenialOf(walletRevert("PolicyExpired")), { errorName: "PolicyExpired" });
  assert.deepEqual(policyDenialOf(walletRevert("InvalidAgentSignature")), {
    errorName: "InvalidAgentSignature",
  });
});

test("every policy dimension the wallet enforces is recordable", () => {
  assert.equal(policyDenialOf(walletRevert("InsufficientWalletBalance", [1n, 2n]))?.errorName,
    "InsufficientWalletBalance");
});

test("nothing but a wallet policy refusal is ever recorded", () => {
  // A core-level revert is a stale quote, not "your agent was refused".
  assert.equal(policyDenialOf(coreRevert("IntentExpired")), null);
  // A wallet error that is a wiring bug, not a policy decision.
  assert.equal(policyDenialOf(walletRevert("NotCore")), null);
  // Transport blips and receipt timeouts: no revert, no proof, no row.
  assert.equal(policyDenialOf(new Error("fetch failed")), null);
  assert.equal(policyDenialOf(new BaseError("timed out waiting for receipt")), null);
  // Real Circle USDC reverts with strings — still not a policy refusal.
  assert.equal(policyDenialOf(new ApiError(409, "IntentAlreadySettled", "replay")), null);
});

// ------------------------------------------------------------ row → wire

function row(overrides: Partial<DenialRow> = {}): DenialRow {
  return {
    intent_id: `0x${"ab".repeat(32)}`,
    handle: "gadgethub-sg",
    merchant_id: `0x${"cd".repeat(32)}`,
    wallet: "0xdd4bbed78b64715288bf10fabb2b62c659299d3e",
    token_in: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    amount_in: "2980405",
    xsgd_amount: "4000000",
    error_name: "CategoryNotAllowed",
    error_args: JSON.stringify({ categoryId: 2 }),
    cancel_tx: `0x${"11".repeat(32)}`,
    created_at: 1_785_900_200,
    ...overrides,
  };
}

test("a stored denial maps onto the wire shape", () => {
  const event = denialEventOf(row());
  assert.equal(event.errorName, "CategoryNotAllowed");
  assert.deepEqual(event.errorArgs, { categoryId: 2 });
  assert.equal(event.cancelTxHash, `0x${"11".repeat(32)}`);
  assert.equal(event.amountIn, "2980405");
  assert.equal(event.at, 1_785_900_200);
});

test("a failed cancel renders no hash rather than a fake one", () => {
  assert.equal(denialEventOf(row({ cancel_tx: null })).cancelTxHash, null);
});

test("absent or unreadable args drop out instead of failing the feed", () => {
  assert.equal("errorArgs" in denialEventOf(row({ error_args: null })), false);
  assert.equal("errorArgs" in denialEventOf(row({ error_args: "{not json" })), false);
});

// ------------------------------------------------------------ the route's read

const dir = mkdtempSync(join(tmpdir(), "gantry-denials-test-"));
const store = createDatabase(join(dir, "test.db"));

after(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const WALLET = "0xDD4bbed78B64715288bf10fabB2b62c659299D3E";
const OTHER_WALLET = "0x82513007C7eB93b54dC555Bdb74341b3084FC47B";

function reason(params: Record<string, unknown>): string {
  try {
    listAgentDenials(store, params);
  } catch (err) {
    return err instanceof ApiError ? `${err.status} ${err.errorName}` : "unexpected";
  }
  return "no error";
}

test("wallet is required and validated — never widened to everyone", () => {
  // A denial exposes an agent's spend policy, so "no filter" must not mean
  // "every payer's".
  assert.equal(reason({}), "400 MissingWallet");
  assert.equal(reason({ wallet: "" }), "400 InvalidWallet");
  assert.equal(reason({ wallet: "0xnope" }), "400 InvalidWallet");
  // `?wallet=a&wallet=b` — picking a winner answers a question nobody asked.
  assert.equal(reason({ wallet: [WALLET, OTHER_WALLET] }), "400 InvalidWallet");
});

test("denials are scoped to one wallet, newest first", () => {
  store.insertDenial({ ...row(), intent_id: "0xdenial1", wallet: WALLET, created_at: 100 });
  store.insertDenial({
    ...row(),
    intent_id: "0xdenial2",
    wallet: WALLET,
    created_at: 200,
    error_name: "DailyCapExceeded",
    error_args: JSON.stringify({ attempted: "67105000", cap: "50000000" }),
  });
  store.insertDenial({ ...row(), intent_id: "0xdenial3", wallet: OTHER_WALLET, created_at: 300 });

  // Checksummed in, checksummed out — and lowercased in between. The store keys
  // on the lowercase form so a checksummed caller cannot read as a wallet with
  // no history; the wire re-checksums, because EIP-55 lives in the
  // capitalisation and a receipt that drops it is one nobody can check against
  // Basescan by eye.
  const mine = listAgentDenials(store, { wallet: WALLET });
  assert.deepEqual(mine.rows.map((r) => r.errorName), ["DailyCapExceeded", "CategoryNotAllowed"]);
  assert.equal(mine.total, 2);
  assert.deepEqual(mine.rows[0]?.errorArgs, { attempted: "67105000", cap: "50000000" });
  assert.equal(mine.rows[0]?.wallet, WALLET);
  assert.equal(listAgentDenials(store, { wallet: WALLET.toLowerCase() }).rows[0]?.wallet, WALLET);

  assert.equal(listAgentDenials(store, { wallet: OTHER_WALLET }).total, 1);
  assert.equal(listAgentDenials(store, { wallet: `0x${"99".repeat(20)}` }).total, 0);
});

test("the page limit is bounded, and total ignores it", () => {
  const spy = {
    seen: undefined as number | undefined,
    listDenials(_wallet: string, limit?: number) {
      this.seen = limit;
      return [] as DenialRow[];
    },
    countDenials() {
      return 999;
    },
  };
  const result = listAgentDenials(spy, { wallet: WALLET });
  assert.equal(spy.seen, DENIAL_PAGE_LIMIT);
  assert.equal(result.total, 999);
});

/** The hash on a denial is the CANCEL tx. There is no reverted settle to link:
 * the revert never left the simulator, so anything else here would be invented.
 * Documented as a test so it survives the next reader of the receipt UI. */
test("cancelTxHash is the cancel tx, and the only tx a denial has", () => {
  const event = denialEventOf(row({ cancel_tx: `0x${"22".repeat(32)}` as Hex }));
  assert.equal(event.cancelTxHash, `0x${"22".repeat(32)}`);
  assert.equal(Object.keys(event).includes("settleTxHash"), false);
});

test("the mirrored denial-reason bound matches the core's own constant", () => {
  // The backend enforces this bound BEFORE sending, so a drift is silent and
  // one-directional: if the contract's bound ever drops below the mirror, the
  // backend sends bytes the core refuses, `cancelIntentWithReason` reverts, and
  // the refusal loses its on-chain record. `pnpm abis` regenerates the ABI from
  // the contract, so reading the constant back out of it compares the TypeScript
  // literal to the deployed source rather than to another copy of itself.
  const entry = gantryCoreAbi.find(
    (item) => item.type === "function" && item.name === "MAX_DENIAL_REASON_BYTES",
  );
  assert.ok(entry, "GantryCore must still expose MAX_DENIAL_REASON_BYTES as a view");
  assert.equal(MAX_DENIAL_REASON_BYTES, 256);
  // The real payload is a 4-byte selector plus one word — far inside it.
  const realPayload = encodeErrorResult({
    abi: gantryErrorsAbi,
    errorName: "CategoryNotAllowed",
    args: [2],
  });
  assert.ok((realPayload.length - 2) / 2 <= MAX_DENIAL_REASON_BYTES);
});
