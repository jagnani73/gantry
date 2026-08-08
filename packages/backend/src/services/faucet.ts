import { erc20Abi, formatEther, type Address } from "viem";
import type { FaucetResponse } from "@gantry/shared";
import { publicClient, relayerAccount } from "../chain";
import { config } from "../config";
import { ApiError } from "../errors";
import { sendRelayerEth, sendRelayerTx } from "../relayer";
import { isDefiniteFailure } from "./bridge";
import { emptyBudget, msUntilReset, release, reserve } from "./faucet-budget";
import { funderCanSend, gasTopUpAmount } from "./faucet-core";

/**
 * Demo-only funder: the relayer TRANSFERS real Circle USDC so a burner payer
 * needs zero setup. It used to mint MockUSDC, which was the weakest item on the
 * honest-labels list — the payer now signs an EIP-3009 authorization against
 * Circle's actual contract.
 *
 * The trade is that real USDC is finite. The grant is sized to one demo payment
 * rather than the old 100-token mint, and running dry is a real failure mode an
 * open mint never had — so it is reported as itself rather than as a bare
 * revert.
 *
 * Two legs, in priority order. USDC is what a payer needs to PAY, and its
 * failure is the caller's problem. A small ETH top-up follows so the payer can
 * send the transactions they now own — agent wallets are theirs, so `setPolicy`
 * and `revoke` are signed by their key — and that leg never throws. The two
 * spend different assets against different ceilings, and neither can exhaust
 * the other's.
 */
/** Must cover the LARGEST single payment a funded payer makes, because the
 * payer page funds once and then signs: the agent-door order is S$4.50 ≈ 3.36
 * USDC, and the burner amount cap (S$5 ≈ 3.73) is deliberately set just under
 * this so one grant always suffices. */
const GRANT = 4_000_000n; // 4 USDC
const COOLDOWN_MS = 60_000;
const BUDGET_WINDOW_MS = 86_400_000; // 24h, rolling from the first grant

/**
 * Where the payer's ETH balance is topped up to. Enough for the owner
 * transactions an agent needs — one `createWallet` (a contract deployment, the
 * expensive one) plus several `setPolicy`/`revoke` calls at Base Sepolia's fees,
 * with room for the L1 data component to move.
 */
const ETH_TARGET = 2_000_000_000_000_000n; // 0.002 ETH
/**
 * ETH the relayer must still hold after a top-up. Matches MIN_ETH_RESERVE in
 * services/funder.ts on purpose: it is the same key and the same question, and
 * two different floors on one balance would be two different wrong answers.
 */
const FUNDER_ETH_RESERVE = 50_000_000_000_000_000n; // 0.05 ETH

const lastFunded = new Map<string, number>();
/**
 * Bounds CONCURRENT grants per address. The cooldown alone only rate-limits
 * strictly serial requests, because `lastFunded` is written after the transfer
 * confirms — so N parallel requests for one address all pass that check and each
 * sends 4 real USDC. Same reasoning as `registerInFlight` in merchants.ts, and
 * it matters more here: onboarding spends gas, this spends the scarce asset.
 */
const inFlight = new Set<string>();

let budget = emptyBudget();
/** The ETH leg's ceiling, counted separately from the USDC one — see
 * config.faucetEthDailyBudget. A shared counter would let a run of gas top-ups
 * close the door on payments, or the reverse. */
let ethBudget = emptyBudget();

export async function fundPayer(address: Address): Promise<FaucetResponse> {
  const key = address.toLowerCase();
  const last = lastFunded.get(key);
  if (last && Date.now() - last < COOLDOWN_MS) {
    throw new ApiError(429, "FaucetCooldown", "faucet cooldown active — try again shortly");
  }
  if (inFlight.has(key)) {
    throw new ApiError(429, "FaucetInFlight", "a grant to this address is already in flight");
  }

  inFlight.add(key);
  try {
    // USDC first: it is the payment spine, and it is the leg whose failure must
    // reach the caller. The gas leg runs after it and never throws.
    const funded = await grant(address, key);
    await topUpPayerGas(address);
    return funded;
  } finally {
    inFlight.delete(key);
  }
}

async function grant(address: Address, key: string): Promise<FaucetResponse> {
  const now = Date.now();
  const reservation = reserve(budget, GRANT, config.faucetDailyBudget, now, BUDGET_WINDOW_MS);
  if (!reservation.ok) {
    // Deliberately NOT committing `reservation.state` here. On the rolled path it
    // carries a fresh `windowStart` with nothing spent, so committing it on a
    // REFUSAL would restart the 24h countdown every time someone is turned away
    // — `msUntilReset` would advertise a full day, forever, for a condition that
    // never improves. Only a granted reservation may move the window.
    const mins = Math.ceil(msUntilReset(reservation.state, now, BUDGET_WINDOW_MS) / 60_000);
    throw new ApiError(
      429,
      "FaucetBudgetExhausted",
      `the demo faucet's daily allowance is spent (${reservation.remaining} units left, ` +
        `resets in ~${mins} min) — pay from a wallet that already holds Base Sepolia USDC, ` +
        "or run a local backend, where funding is unmetered.",
    );
  }
  budget = reservation.state;

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
        `the demo funder is out of USDC (holds ${funderBalance}, needs ${GRANT}) — top up ${relayerAccount.address}`,
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
    lastFunded.set(key, Date.now());
    return { txHash: receipt.transactionHash, funded: GRANT.toString() };
  } catch (err) {
    if (isDefiniteFailure(err)) {
      // Proven that nothing moved: a pre-broadcast ApiError, a decoded revert, or
      // a mined-but-reverted receipt. Safe to hand the allowance back.
      budget = release(budget, GRANT);
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
    lastFunded.set(key, Date.now());
    console.error(
      `faucet CRITICAL: grant of ${GRANT} to ${address} has an UNRESOLVED outcome — ` +
        `reservation kept and cooldown armed. Check the address on-chain before re-granting.`,
      err,
    );
    throw err;
  }
}

/**
 * The second leg: enough ETH for the payer to send their OWN transactions.
 *
 * Agent wallets are owned by the payer, and `createWallet`, `setPolicy` and
 * `revoke` are `onlyOwner` — so those are the payer's transactions, signed with
 * the payer's key, and a key that has never held ETH cannot send them. This does
 * not weaken the payment story: paying a merchant is still an EIP-3009
 * signature the relayer submits, and costs the payer nothing. Label it as what
 * it is — an owner funding their own wallet, which is ordinary.
 *
 * Never fatal, deliberately. By the time this runs the USDC grant has already
 * landed, and the two failures are not comparable: a payer who cannot configure
 * an agent has one screen they cannot use, while a payer who cannot be funded
 * cannot pay at all. So every failure here is logged and swallowed.
 *
 * It also spends the ONE asset whose exhaustion stops everything. The relayer's
 * ETH pays for QR settlement, x402 settlement, intent creation and merchant
 * registration; running it down does not degrade the demo, it ends it. Hence
 * three independent bounds, none of which can be traded for another: the
 * per-address cooldown and in-flight set shared with the USDC leg, a rolling
 * 24h ceiling of its own, and a floor on what the funder keeps.
 */
async function topUpPayerGas(address: Address): Promise<void> {
  let reserved = 0n;
  try {
    const balance = await publicClient.getBalance({ address });
    const send = gasTopUpAmount(balance, ETH_TARGET);
    if (send === 0n) return;

    const now = Date.now();
    const reservation = reserve(ethBudget, send, config.faucetEthDailyBudget, now, BUDGET_WINDOW_MS);
    if (!reservation.ok) {
      // Same rule as the USDC leg: a refusal must NOT commit the rolled state,
      // or `msUntilReset` advertises a fresh day every time someone is turned
      // away and the countdown never actually runs down.
      const mins = Math.ceil(msUntilReset(reservation.state, now, BUDGET_WINDOW_MS) / 60_000);
      console.warn(
        `faucet: gas top-up for ${address} refused — the 24h ETH allowance is spent ` +
          `(${formatEther(reservation.remaining)} ETH left, resets in ~${mins} min). ` +
          `The payer can still pay; they cannot configure an agent until they hold gas.`,
      );
      return;
    }
    ethBudget = reservation.state;
    reserved = send;

    const funderEth = await publicClient.getBalance({ address: relayerAccount.address });
    if (!funderCanSend(funderEth, send, FUNDER_ETH_RESERVE)) {
      // ApiError is a definite failure, so the catch below hands the allowance
      // back. Said plainly because this is the sentence an operator needs: the
      // gas key is close to the floor and every door is about to fail with it.
      throw new ApiError(
        503,
        "FunderGasLow",
        `cannot spare ${formatEther(send)} ETH for ${address}: the relayer holds ` +
          `${formatEther(funderEth)} and keeps ${formatEther(FUNDER_ETH_RESERVE)} for relaying — ` +
          `top up ${relayerAccount.address}`,
      );
    }

    await sendRelayerEth(address, send);
  } catch (err) {
    if (reserved === 0n) {
      // A read failed before anything was reserved or sent.
      console.warn(`faucet: gas top-up for ${address} skipped`, err);
      return;
    }
    if (isDefiniteFailure(err)) {
      // Proven that nothing moved — a pre-broadcast ApiError or a
      // mined-but-reverted receipt. Safe to hand the allowance back.
      ethBudget = release(ethBudget, reserved);
      console.warn(`faucet: gas top-up of ${formatEther(reserved)} ETH to ${address} failed`, err);
      return;
    }
    // Ambiguous — a receipt timeout or a transport failure after broadcast. The
    // compensation invariant applies here exactly as it does to the USDC leg:
    // the helper throwing does not prove the transaction did not happen, so the
    // reservation is KEPT (over-counting costs one top-up; under-counting hands
    // out ETH nothing accounted for) and nothing is re-sent.
    //
    // What makes this leg self-correcting is that it is a top-up rather than a
    // grant: if the transaction we could not confirm did land, the next call
    // reads the higher balance and sends nothing. A flat per-call grant would
    // instead double up on exactly this path.
    console.error(
      `faucet CRITICAL: gas top-up of ${formatEther(reserved)} ETH to ${address} has an ` +
        `UNRESOLVED outcome — reservation kept, nothing re-sent. Check the address on-chain.`,
      err,
    );
  }
}
