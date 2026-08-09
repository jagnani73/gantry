import { erc20Abi, formatEther, type Address, type Hex } from "viem";
import type { FaucetResponse } from "@gantry/shared";
import { publicClient, relayerAccount } from "../chain";
import { config } from "../config";
import { ApiError } from "../errors";
import { sendRelayerEth, sendRelayerTx } from "../relayer";
import { isDefiniteFailure } from "./bridge";
import {
  ETH_TARGET,
  FUNDER_ETH_RESERVE,
  GRANT,
  createFaucetLegs,
  funderCanSend,
  gasTopUpAmount,
  type LegRefusal,
} from "./faucet-core";

/**
 * Demo-only funder: the relayer TRANSFERS real Circle USDC so an unfunded payer
 * needs zero setup. It used to mint MockUSDC, which was the weakest item on the
 * honest-labels list — the payer now signs an EIP-3009 authorization against
 * Circle's actual contract.
 *
 * The trade is that real USDC is finite. The grant is sized to one demo payment
 * rather than the old 100-token mint, and running dry is a real failure mode an
 * open mint never had — so it is reported as itself rather than as a bare
 * revert.
 *
 * TWO LEGS, AND THEY ARE INDEPENDENT — in reachability, not merely in
 * accounting. USDC is what a payer needs to PAY; ETH is what a payer needs to
 * send the transactions they OWN (agent wallets are theirs, so `setPolicy` and
 * `revoke` are signed by their key). Each leg has its own rolling ceiling, its
 * own per-address cooldown and its own in-flight set, and each has an entry
 * point that fails in its own vocabulary:
 *
 *   fundPayer(address)     — "make this payer able to pay"; USDC is fatal, gas
 *                            is reported.
 *   fundPayerGas(address)  — "make this payer able to send"; gas is fatal, and
 *                            the USDC ceiling is never touched.
 *
 * They used to be one serial call in the other order, which meant every USDC
 * refusal — a 60s cooldown from the payment 30 seconds ago, a spent daily
 * allowance — made the gas leg unreachable. A presenter paying S$1.50 and then
 * tapping Revoke got a 429 about USDC while the ETH ceiling sat untouched.
 */

/** Everything rate-limiting, per leg. Ceilings are wired to legs inside
 * faucet-core so a test can prove which one each leg got. */
const legs = createFaucetLegs(config.hostClass === "demo");

/** The gas leg's outcome, reported rather than thrown on the payment path. */
export interface GasTopUpResult {
  /** null when nothing was sent — the payer already held the target, or the
   * top-up was refused (see `error`). */
  txHash: Hex | null;
  /** Wei transferred; "0" when nothing was sent. */
  funded: string;
  /** Why nothing was sent, when that was a refusal rather than "not needed".
   * Named so a screen can say "gas top-up refused" instead of inventing one. */
  error?: { name: string; message: string };
}

/** Structurally a FaucetResponse (the shared wire type) plus the gas leg's
 * outcome — an added optional-shaped field, so every existing client keeps
 * reading the same two. */
export interface FaucetGrantResponse extends FaucetResponse {
  gas: GasTopUpResult;
}

/** A fresh object each time, never one shared instance: this is handed straight
 * to a response body, and two requests must not be able to alias it. */
const nothingSent = (): GasTopUpResult => ({ txHash: null, funded: "0" });

/**
 * The payment entry point: 4 USDC, plus enough ETH for the payer's own
 * transactions.
 *
 * The USDC leg is the fatal one here — a payer who cannot be funded cannot pay
 * at all, while a payer without gas has one screen they cannot use — so its
 * refusals still throw exactly as they always did. The gas leg runs FIRST and
 * never throws on this path, which is what makes it reachable even when the
 * USDC leg is about to refuse.
 */
export async function fundPayer(address: Address): Promise<FaucetGrantResponse> {
  const gas = await topUpGas(address, false);
  const funded = await grantUsdc(address);
  return { ...funded, gas };
}

/**
 * The gas-only entry point, for a caller that wants to SEND rather than pay —
 * the payer app asks for this before an `onlyOwner` write when the key is empty.
 *
 * It never reserves, spends or waits on the USDC leg: that asset is scarce
 * (five grants a day on a public host) and a caller who already holds plenty of
 * USDC must not burn a grant to get 0.002 ETH. Failures throw, and they throw
 * in gas vocabulary — the whole point is that the caller hears about gas.
 *
 * `txHash: null` with `funded: "0"` is a SUCCESS: the payer already held the
 * target and nothing needed sending.
 */
export function fundPayerGas(address: Address): Promise<GasTopUpResult> {
  return topUpGas(address, true);
}

// ------------------------------------------------------------------ USDC leg

async function grantUsdc(address: Address): Promise<FaucetResponse> {
  const key = address.toLowerCase();
  const refusal = legs.usdc.claim(key, GRANT, Date.now());
  if (refusal) throw usdcRefusalError(refusal);

  // Everything from the reservation to a confirmed transfer lives in one try, so
  // there is no path that counts a grant against the day's allowance without
  // either spending it or giving it back. The balance read below is the reason
  // this bracket has to start here rather than at the transfer: an RPC failure
  // on a READ moves no funds, and used to burn 4 USDC of the ceiling anyway.
  try {
    const usdc = config.addresses.realUsdc;
    const funderBalance = await publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [relayerAccount.address],
    });
    if (funderBalance < GRANT) {
      // Say what actually happened: a bare transfer revert reads like a bug.
      // ApiError is a definite failure, so the catch below releases the grant.
      throw new ApiError(
        503,
        "FunderExhausted",
        `the demo funder is out of USDC (holds ${funderBalance}, needs ${GRANT}). Top up ${relayerAccount.address}`,
      );
    }

    const { receipt } = await sendRelayerTx({
      address: usdc,
      abi: erc20Abi,
      functionName: "transfer",
      args: [address, GRANT],
    });
    // Cooldown only after a successful transfer — a failed one must surface its
    // real error on retry, not a bogus 429.
    legs.usdc.armCooldown(key, Date.now());
    return { txHash: receipt.transactionHash, funded: GRANT.toString() };
  } catch (err) {
    if (isDefiniteFailure(err)) {
      // Proven that nothing moved: a pre-broadcast ApiError, a decoded revert, or
      // a mined-but-reverted receipt. Safe to hand the allowance back.
      legs.usdc.release(GRANT);
      throw err;
    }
    // Ambiguous — a receipt timeout or a transport failure after broadcast. The
    // repo's compensation invariant applies: never assume the helper throwing
    // means the tx did not happen. KEEP the reservation, because over-counting
    // costs one grant while under-counting hands out USDC nothing accounted for.
    //
    // Arming the cooldown is the half that actually prevents loss: without it the
    // payer taps retry, the first transfer has not mined yet so their balance is
    // still short, and a SECOND grant goes out against a ceiling that recorded
    // one. viem puts the tx hash in the timeout message, which is what makes the
    // manual check below possible.
    legs.usdc.armCooldown(key, Date.now());
    console.error(
      `faucet CRITICAL: grant of ${GRANT} to ${address} has an UNRESOLVED outcome — ` +
        `reservation kept and cooldown armed. Check the address on-chain before re-granting.`,
      err,
    );
    throw err;
  } finally {
    legs.usdc.finish(key);
  }
}

function usdcRefusalError(refusal: LegRefusal): ApiError {
  if (refusal.kind === "cooldown") {
    return new ApiError(429, "FaucetCooldown", "faucet cooldown active; try again shortly");
  }
  if (refusal.kind === "in_flight") {
    return new ApiError(429, "FaucetInFlight", "a grant to this address is already in flight");
  }
  const mins = Math.ceil(refusal.resetInMs / 60_000);
  return new ApiError(
    429,
    "FaucetBudgetExhausted",
    `the demo faucet's daily allowance is spent (${refusal.remaining} units left, ` +
      `resets in ~${mins} min). Pay from a wallet that already holds Base Sepolia USDC, ` +
      "or run a local backend, where funding is unmetered.",
  );
}

// ------------------------------------------------------------------- gas leg

/**
 * Enough ETH for the payer to send their OWN transactions.
 *
 * Agent wallets are owned by the payer, and `createWallet`, `setPolicy` and
 * `revoke` are `onlyOwner` — so those are the payer's transactions, signed with
 * the payer's key, and a key that has never held ETH cannot send them. This does
 * not weaken the payment story: paying a merchant is still an EIP-3009
 * signature the relayer submits, and costs the payer nothing. Label it as what
 * it is — an owner funding their own wallet, which is ordinary.
 *
 * `fatal` is the caller's motive, not a policy: on `fundPayer` the USDC grant is
 * the point and a gas failure is a warning, while on `fundPayerGas` gas IS the
 * request and swallowing its failure would hand back a 200 that fixed nothing.
 * Either way the leg is entered and the guards below run identically.
 *
 * This leg spends the ONE asset whose exhaustion stops everything. The relayer's
 * ETH pays for QR settlement, x402 settlement, intent creation and merchant
 * registration; running it down does not degrade the demo, it ends it. Hence
 * three independent bounds, none of which can be traded for another: a
 * per-address cooldown and in-flight set of its OWN (never the USDC leg's), a
 * rolling 24h ceiling of its own, and a floor on what the funder keeps.
 */
async function topUpGas(address: Address, fatal: boolean): Promise<GasTopUpResult> {
  const key = address.toLowerCase();
  let reserved = 0n;
  // Only the request that actually OWNS the claim may release it. `finish`
  // deletes by key without asking who put it there, and this function reaches
  // its `finally` on two paths that never claimed: an address already at target
  // (returns early) and one refused BECAUSE another request holds the key. Both
  // would clear the in-flight marker of the request mid-transfer, letting a
  // third claim and send a second top-up before the first arms its cooldown —
  // repeatable, against the relayer's only gas key, which pays for every door.
  // `grantUsdc` avoids this by claiming before its try; this leg has to read a
  // balance first to know the amount, so it tracks ownership instead.
  let claimed = false;
  try {
    const balance = await publicClient.getBalance({ address });
    const send = gasTopUpAmount(balance, ETH_TARGET);
    // Already funded. Claimed nothing, so no cooldown is armed and no allowance
    // moves — which is what makes this callable before every owner write.
    if (send === 0n) return nothingSent();

    const refusal = legs.gas.claim(key, send, Date.now());
    if (refusal) throw gasRefusalError(refusal, address, send);
    claimed = true;
    reserved = send;

    const funderEth = await publicClient.getBalance({ address: relayerAccount.address });
    if (!funderCanSend(funderEth, send, FUNDER_ETH_RESERVE)) {
      // ApiError is a definite failure, so the handler below hands the allowance
      // back. Said plainly because this is the sentence an operator needs: the
      // gas key is close to the floor and every door is about to fail with it.
      throw new ApiError(
        503,
        "FunderGasLow",
        `cannot spare ${formatEther(send)} ETH for ${address}: the relayer holds ` +
          `${formatEther(funderEth)} and keeps ${formatEther(FUNDER_ETH_RESERVE)} for relaying. ` +
          `Top up ${relayerAccount.address}`,
      );
    }

    const receipt = await sendRelayerEth(address, send);
    legs.gas.armCooldown(key, Date.now());
    return { txHash: receipt.transactionHash, funded: send.toString() };
  } catch (err) {
    return resolveFailedGasTopUp(err, address, reserved, fatal);
  } finally {
    if (claimed) legs.gas.finish(key);
  }
}

function resolveFailedGasTopUp(
  err: unknown,
  address: Address,
  reserved: bigint,
  fatal: boolean,
): GasTopUpResult {
  const key = address.toLowerCase();
  if (reserved === 0n) {
    // Nothing was reserved: a read failed, or the leg refused before spending.
    console.warn(`faucet: gas top-up for ${address} not sent`, err);
  } else if (isDefiniteFailure(err)) {
    // Proven that nothing moved — a pre-broadcast ApiError or a
    // mined-but-reverted receipt. Safe to hand the allowance back.
    legs.gas.release(reserved);
    console.warn(`faucet: gas top-up of ${formatEther(reserved)} ETH to ${address} failed`, err);
  } else {
    // Ambiguous — a receipt timeout or a transport failure after broadcast. The
    // compensation invariant applies here exactly as it does to the USDC leg:
    // the helper throwing does not prove the transaction did not happen, so the
    // reservation is KEPT (over-counting costs one top-up; under-counting hands
    // out ETH nothing accounted for) and nothing is re-sent.
    //
    // The cooldown is armed, exactly as the USDC leg arms it, and for the same
    // reason. This branch used to skip it on the reasoning that a top-up is
    // self-correcting: if the unconfirmed transfer landed, the next call reads a
    // higher balance and sends nothing. That argument has only two cases and the
    // real world has three. The dominant ambiguous outcome here is the relayer's
    // 20s receipt cap firing on a transaction that is broadcast and STILL
    // PENDING — the balance has not risen yet, `gasTopUpAmount` returns the full
    // target again, and the retry broadcasts a SECOND transfer. Each one also
    // takes a relayer nonce ahead of the settlement queue.
    //
    // So the cooldown is the half that actually prevents loss, and the cost of
    // arming it is bounded and visible: a payer whose transfer genuinely failed
    // waits a minute. Under-counting hands out ETH nothing accounted for.
    legs.gas.armCooldown(key, Date.now());
    console.error(
      `faucet CRITICAL: gas top-up of ${formatEther(reserved)} ETH to ${address} has an ` +
        `UNRESOLVED outcome. Reservation kept and cooldown armed, nothing re-sent. ` +
        `Check the address on-chain before re-granting.`,
      err,
    );
  }

  if (fatal) throw err;
  return {
    ...nothingSent(),
    error: {
      name: err instanceof ApiError ? err.errorName : "GasTopUpFailed",
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

/** Gas vocabulary throughout — a caller that asked for gas must never be given
 * advice about USDC, and the names differ from the USDC leg's so a client can
 * tell which ceiling it hit. */
function gasRefusalError(refusal: LegRefusal, address: Address, send: bigint): ApiError {
  if (refusal.kind === "cooldown") {
    return new ApiError(
      429,
      "FaucetGasCooldown",
      `gas top-up cooldown active for ${address}; try again in ~${Math.ceil(refusal.retryInMs / 1000)}s`,
    );
  }
  if (refusal.kind === "in_flight") {
    return new ApiError(429, "FaucetGasInFlight", "a gas top-up for this address is already in flight");
  }
  const mins = Math.ceil(refusal.resetInMs / 60_000);
  return new ApiError(
    429,
    "FaucetGasBudgetExhausted",
    `the demo faucet's daily gas allowance is spent (needs ${formatEther(send)} ETH, ` +
      `${formatEther(refusal.remaining)} left, resets in ~${mins} min). The payer can still ` +
      "pay; they cannot configure an agent until they hold gas. Send ETH to the address, or " +
      "run a local backend, where funding is unmetered.",
  );
}
