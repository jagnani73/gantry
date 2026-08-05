import type { Address } from "viem";
import type { FaucetResponse } from "@gantry/shared";
import { config } from "../config";
import { ApiError } from "../errors";
import { sendRelayerTx } from "../relayer";

/** Demo-only: relayer mints MockUSDC (open mint) so burner payers need zero setup. */
const MINT_AMOUNT = 100_000_000n; // 100 USDC
const COOLDOWN_MS = 60_000;

const lastMint = new Map<string, number>();

const mintAbi = [
  {
    type: "function",
    name: "mint",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export async function faucetMint(address: Address): Promise<FaucetResponse> {
  if (!config.faucetEnabled) {
    throw new ApiError(403, "FaucetDisabled", "faucet is disabled on this deployment");
  }
  const key = address.toLowerCase();
  const last = lastMint.get(key);
  if (last && Date.now() - last < COOLDOWN_MS) {
    throw new ApiError(429, "FaucetCooldown", "faucet cooldown active — try again shortly");
  }
  lastMint.set(key, Date.now());

  const { receipt } = await sendRelayerTx({
    address: config.addresses.mockUsdc,
    abi: mintAbi,
    functionName: "mint",
    args: [address, MINT_AMOUNT],
  });
  return { txHash: receipt.transactionHash, minted: MINT_AMOUNT.toString() };
}
