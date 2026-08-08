import type { Hex } from "viem";
import {
  CATEGORIES,
  DEMO_POLICY,
  agentPbmWalletAbi,
  eip3009TokenAbi,
  isKnownCategory,
  parseSgd,
  quoteAmountIn,
  tokenAddress,
  type PolicyResponse,
  type SetPolicyRequest,
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

export async function readPolicy(): Promise<PolicyResponse> {
  const wallet = config.demoPbmWallet;
  const token = "USDC" as const;
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
    token,
    balance: balance.toString(),
    rate: rate.toString(),
    revoked: Number(expiry) === 0,
  };
}

/** The dashboard's Revoke button: zeroes the policy (expired-by-default). */
export async function revokePolicy(): Promise<Hex> {
  const wallet = config.demoPbmWallet;
  const { receipt } = await sendRelayerTx({
    address: wallet,
    abi: agentPbmWalletAbi,
    functionName: "revoke",
    args: [],
  });
  return receipt.transactionHash;
}

/**
 * The agent console's editor. Same on-chain call as the rehearsal re-arm, with
 * the owner's numbers instead of the demo constants.
 *
 * Caps arrive in S$ and are stored in TOKEN units, so they convert through the
 * same owner-set rate the UI shows. `quoteAmountIn` CEILs, which is the correct
 * direction here for the same reason it is on a payment quote: a floored cap
 * would sit a hair under the S$ figure the owner typed, and a purchase priced at
 * exactly the cap would revert — a cap that reads S$50 must actually permit S$50.
 */
export async function setPolicy(req: SetPolicyRequest): Promise<Hex> {
  const wallet = config.demoPbmWallet;
  const dailySgd = parseSgd(req.dailyCapSgd);
  const perTxSgd = parseSgd(req.perTxCapSgd);
  if (dailySgd <= 0n) throw new ApiError(400, "InvalidPolicy", "daily cap must be greater than zero");
  if (perTxSgd <= 0n) throw new ApiError(400, "InvalidPolicy", "per-transaction cap must be greater than zero");
  if (perTxSgd > dailySgd) {
    // Not a contract rule — the wallet checks perTx first, then daily — but a
    // per-tx cap above the daily one can never bind, so it is always a mistake.
    throw new ApiError(400, "InvalidPolicy", "per-transaction cap cannot exceed the daily cap");
  }
  if (req.expiryDays <= 0) throw new ApiError(400, "InvalidPolicy", "expiry must be at least one day");
  if (req.categoryIds.length === 0) {
    // An empty bitmap denies everything, which is what revoke() is for. Refusing
    // it here keeps "no categories" from looking like a subtler kind of active.
    throw new ApiError(400, "InvalidPolicy", "select at least one category — use Revoke to deny everything");
  }
  for (const id of req.categoryIds) {
    if (!isKnownCategory(id)) throw new ApiError(400, "InvalidCategory", `unknown category: ${id}`, [id]);
  }

  const rate = await readRate("USDC");
  const dailyCap = quoteAmountIn(dailySgd, rate);
  const perTxCap = quoteAmountIn(perTxSgd, rate);
  const categoryBitmap = req.categoryIds.reduce((bits, id) => bits | (1n << BigInt(id)), 0n);
  // Chain time, not the laptop's: a skewed clock would arm an already-dead policy.
  const block = await publicClient.getBlock();

  const { receipt } = await sendRelayerTx({
    address: wallet,
    abi: agentPbmWalletAbi,
    functionName: "setPolicy",
    args: [
      {
        dailyCap,
        perTxCap,
        expiry: Number(block.timestamp) + req.expiryDays * 86_400,
        categoryBitmap,
      },
    ],
  });
  return receipt.transactionHash;
}

/** The rehearsal re-arm: setPolicy resets the wallet's spentToday counter, so
 * ten S$4.50 rehearsals never pile into the S$50 cap. Chain time for expiry
 * (a skewed laptop otherwise arms an already-expired policy). */
export async function armDemoPolicy(): Promise<Hex> {
  const wallet = config.demoPbmWallet;
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
