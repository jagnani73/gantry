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
  const key = address.toLowerCase();
  const last = lastMint.get(key);
  if (last && Date.now() - last < COOLDOWN_MS) {
    throw new ApiError(429, "FaucetCooldown", "faucet cooldown active — try again shortly");
  }

  const { receipt } = await sendRelayerTx({
    address: config.addresses.mockUsdc,
    abi: mintAbi,
    functionName: "mint",
    args: [address, MINT_AMOUNT],
  });
  // Cooldown only after a successful mint — a failed mint must surface its
  // real error on retry, not a bogus 429.
  lastMint.set(key, Date.now());
  return { txHash: receipt.transactionHash, minted: MINT_AMOUNT.toString() };
}
