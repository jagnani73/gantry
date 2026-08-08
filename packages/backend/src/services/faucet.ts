import { erc20Abi, type Address } from "viem";
import type { FaucetResponse } from "@gantry/shared";
import { publicClient, relayerAccount } from "../chain";
import { config } from "../config";
import { ApiError } from "../errors";
import { sendRelayerTx } from "../relayer";
import { isDefiniteFailure } from "./bridge";
import { emptyBudget, msUntilReset, release, reserve } from "./faucet-budget";

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
 */
/** Must cover the LARGEST single payment a funded payer makes, because the
 * payer page funds once and then signs: the agent-door order is S$4.50 ≈ 3.36
 * USDC, and the burner amount cap (S$5 ≈ 3.73) is deliberately set just under
 * this so one grant always suffices. */
const GRANT = 4_000_000n; // 4 USDC
const COOLDOWN_MS = 60_000;
const BUDGET_WINDOW_MS = 86_400_000; // 24h, rolling from the first grant

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
    return await grant(address, key);
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
