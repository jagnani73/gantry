import { erc20Abi, type Address } from "viem";
import type { FaucetResponse } from "@gantry/shared";
import { publicClient, relayerAccount } from "../chain";
import { config } from "../config";
import { ApiError } from "../errors";
import { sendRelayerTx } from "../relayer";
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

const lastFunded = new Map<string, number>();

const BUDGET_WINDOW_MS = 86_400_000; // 24h, rolling from the first grant
let budget = emptyBudget();

export async function fundPayer(address: Address): Promise<FaucetResponse> {
  const key = address.toLowerCase();
  const last = lastFunded.get(key);
  if (last && Date.now() - last < COOLDOWN_MS) {
    throw new ApiError(429, "FaucetCooldown", "faucet cooldown active — try again shortly");
  }

  // Reserved before the transfer, so two concurrent callers cannot both pass the
  // check and overshoot. Released below on any failure.
  const now = Date.now();
  const reservation = reserve(budget, GRANT, config.faucetDailyBudget, now, BUDGET_WINDOW_MS);
  budget = reservation.state;
  if (!reservation.ok) {
    const mins = Math.ceil(msUntilReset(budget, now, BUDGET_WINDOW_MS) / 60_000);
    throw new ApiError(
      429,
      "FaucetBudgetExhausted",
      `the demo faucet's daily allowance is spent (${reservation.remaining} units left, ` +
        `resets in ~${mins} min) — pay from a wallet that already holds Base Sepolia USDC, ` +
        "or run a local backend, where funding is unmetered.",
    );
  }

  const usdc = config.addresses.realUsdc;
  const funderBalance = await publicClient.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [relayerAccount.address],
  });
  if (funderBalance < GRANT) {
    // Say what actually happened: a bare transfer revert reads like a bug.
    budget = release(budget, GRANT);
    throw new ApiError(
      503,
      "FunderExhausted",
      `the demo funder is out of USDC (holds ${funderBalance}, needs ${GRANT}) — top up ${relayerAccount.address}`,
    );
  }

  let receipt;
  try {
    ({ receipt } = await sendRelayerTx({
      address: usdc,
      abi: erc20Abi,
      functionName: "transfer",
      args: [address, GRANT],
    }));
  } catch (err) {
    // A transfer that never landed must not eat the day's allowance. The reverse
    // case — a receipt timeout on a transfer that later mines — deliberately
    // keeps the reservation: over-counting the budget costs a grant, while
    // under-counting it hands out USDC nothing accounted for.
    budget = release(budget, GRANT);
    throw err;
  }
  // Cooldown only after a successful transfer — a failed one must surface its
  // real error on retry, not a bogus 429.
  lastFunded.set(key, Date.now());
  return { txHash: receipt.transactionHash, funded: GRANT.toString() };
}
