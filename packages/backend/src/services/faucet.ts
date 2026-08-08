import { erc20Abi, type Address } from "viem";
import type { FaucetResponse } from "@gantry/shared";
import { publicClient, relayerAccount } from "../chain";
import { config } from "../config";
import { ApiError } from "../errors";
import { sendRelayerTx } from "../relayer";

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

export async function fundPayer(address: Address): Promise<FaucetResponse> {
  if (!config.demoFundingEnabled) {
    // Named and explained rather than a bare 403: the one way this bites is a
    // rehearsal started with NODE_ENV=production, where burner mode would
    // otherwise fail with no clue why. This message IS the diagnosis.
    throw new ApiError(
      403,
      "FaucetDisabled",
      "payer funding is off because NODE_ENV=production — burner mode only works on a demo host. " +
        "Unset NODE_ENV (or set it to development) and restart, or fund the payer address directly.",
    );
  }

  const key = address.toLowerCase();
  const last = lastFunded.get(key);
  if (last && Date.now() - last < COOLDOWN_MS) {
    throw new ApiError(429, "FaucetCooldown", "faucet cooldown active — try again shortly");
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
}
