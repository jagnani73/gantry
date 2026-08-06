import type { Address, Hex } from "viem";
import {
  CATEGORIES,
  DEMO_POLICY,
  agentPbmWalletAbi,
  eip3009TokenAbi,
  tokenAddress,
  type PolicyResponse,
} from "@gantry/shared";
import { publicClient } from "../chain";
import { config } from "../config";
import { ApiError } from "../errors";
import { sendRelayerTx } from "../relayer";
import { readRate } from "./intents";

/**
 * On-chain AgentPBMWallet state for the dashboard panel, the agent's
 * check_my_policy tool, and the demo-reset re-arm. The relayer key IS the demo
 * wallet's owner (DeployPBM broadcasts from it), which is what lets revoke and
 * setPolicy route through sendRelayerTx.
 */

function requireWallet(): Address {
  if (!config.demoPbmWallet) {
    throw new ApiError(404, "PolicyWalletUnconfigured", "no demo PBM wallet configured on this chain");
  }
  return config.demoPbmWallet;
}

export async function readPolicy(): Promise<PolicyResponse> {
  const wallet = requireWallet();
  const token = config.orderToken;
  const [policy, spentToday, agentSigner, balance, rate] = await Promise.all([
    publicClient.readContract({ address: wallet, abi: agentPbmWalletAbi, functionName: "policy" }),
    publicClient.readContract({ address: wallet, abi: agentPbmWalletAbi, functionName: "spentToday" }),
    publicClient.readContract({ address: wallet, abi: agentPbmWalletAbi, functionName: "agentSigner" }),
    publicClient.readContract({
      address: tokenAddress(config.addresses, token),
      abi: eip3009TokenAbi,
      functionName: "balanceOf",
      args: [wallet],
    }),
    readRate(token),
  ]);
  const [dailyCap, perTxCap, expiry, categoryBitmap] = policy;
  const categories = Object.entries(CATEGORIES)
    .filter(([id]) => (categoryBitmap >> BigInt(id)) & 1n)
    .map(([, name]) => name);
  return {
    wallet,
    agentSigner,
    dailyCap: dailyCap.toString(),
    perTxCap: perTxCap.toString(),
    spentToday: spentToday.toString(),
    expiry: Number(expiry),
    categoryBitmap: categoryBitmap.toString(),
    categories,
    balance: balance.toString(),
    rate: rate.toString(),
    revoked: Number(expiry) === 0,
  };
}

/** The dashboard's Revoke button: zeroes the policy (expired-by-default). */
export async function revokePolicy(): Promise<Hex> {
  const wallet = requireWallet();
  const { receipt } = await sendRelayerTx({
    address: wallet,
    abi: agentPbmWalletAbi,
    functionName: "revoke",
    args: [],
  });
  return receipt.transactionHash;
}

/** The rehearsal re-arm: setPolicy resets the wallet's spentToday counter, so
 * ten S$19.50 rehearsals never pile into the S$50 cap. Chain time for expiry
 * (a skewed laptop otherwise arms an already-expired policy). */
export async function armDemoPolicy(): Promise<Hex> {
  const wallet = requireWallet();
  const block = await publicClient.getBlock();
  const { receipt } = await sendRelayerTx({
    address: wallet,
    abi: agentPbmWalletAbi,
    functionName: "setPolicy",
    args: [
      {
        dailyCap: DEMO_POLICY.dailyCap,
        perTxCap: DEMO_POLICY.perTxCap,
        expiry: Number(block.timestamp) + DEMO_POLICY.policyTtlSeconds,
        categoryBitmap: DEMO_POLICY.categoryBitmap,
      },
    ],
  });
  return receipt.transactionHash;
}
