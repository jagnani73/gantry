import { erc20Abi, formatEther, formatUnits, type Address } from "viem";
import { publicClient, relayerAccount } from "../chain";
import { config } from "../config";
import { ApiError } from "../errors";
import { sendRelayerTx } from "../relayer";

/**
 * Refills the demo funder by swapping ETH for real USDC on Uniswap v3.
 *
 * Testnet ETH is easy to come by and testnet USDC is not, so this converts the
 * abundant asset into the scarce one. It is called by `demo:reset` — never from
 * the payment path. A swap involves three transactions and a live pool; putting
 * that in front of a waiting payer would turn "the funder is low" (slow,
 * visible, fixable between sessions) into "the payment failed" (fast, invisible,
 * on stage). Here a failure is a line of output before the rehearsal starts.
 */

/** Below this, top up. Above it, do nothing — so a reset does not swap every run. */
const FLOOR = 15_000_000n; // 15 USDC
const TARGET = 50_000_000n; // 50 USDC
/** Slippage allowance on the quoted ETH input. The 0.3% pool holds ~1.5k USDC,
 * so a ~35 USDC buy is a few percent of one side. */
const SLIPPAGE_BPS = 300n;

const WETH: Address = "0x4200000000000000000000000000000000000006"; // OP-stack predeploy
const SWAP_ROUTER: Address = "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4";
const QUOTER: Address = "0xC5290058841028F1614F3A6F0F5816cAd0df5E27";
const POOL_FEE = 3000;
/** Leave enough ETH behind to keep relaying — the gas key funds every door. */
const MIN_ETH_RESERVE = 50_000_000_000_000_000n; // 0.05 ETH

const wethAbi = [
  { type: "function", name: "deposit", inputs: [], outputs: [], stateMutability: "payable" },
] as const;

const quoterAbi = [
  {
    type: "function",
    name: "quoteExactOutputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        type: "tuple",
        name: "params",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const routerAbi = [
  {
    type: "function",
    name: "exactOutputSingle",
    stateMutability: "payable",
    inputs: [
      {
        type: "tuple",
        name: "params",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountOut", type: "uint256" },
          { name: "amountInMaximum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountIn", type: "uint256" }],
  },
] as const;

export interface FunderStatus {
  funder: Address;
  eth: string;
  usdc: string;
  swapped: boolean;
  detail: string;
}

async function usdcBalance(): Promise<bigint> {
  return publicClient.readContract({
    address: config.addresses.realUsdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [relayerAccount.address],
  });
}

async function status(swapped: boolean, detail: string): Promise<FunderStatus> {
  const [eth, usdc] = await Promise.all([
    publicClient.getBalance({ address: relayerAccount.address }),
    usdcBalance(),
  ]);
  return {
    funder: relayerAccount.address,
    eth: formatEther(eth),
    usdc: formatUnits(usdc, 6),
    swapped,
    detail,
  };
}

export async function topUpFunder(): Promise<FunderStatus> {
  const balance = await usdcBalance();
  if (balance >= FLOOR) {
    return status(false, `USDC above the ${formatUnits(FLOOR, 6)} floor — no swap needed`);
  }

  const need = TARGET - balance;
  const [quotedEthIn] = await publicClient
    .simulateContract({
      address: QUOTER,
      abi: quoterAbi,
      functionName: "quoteExactOutputSingle",
      args: [
        { tokenIn: WETH, tokenOut: config.addresses.realUsdc, amount: need, fee: POOL_FEE, sqrtPriceLimitX96: 0n },
      ],
    })
    .then((r) => r.result);

  const maxEthIn = (quotedEthIn * (10_000n + SLIPPAGE_BPS)) / 10_000n;
  const ethBalance = await publicClient.getBalance({ address: relayerAccount.address });
  if (ethBalance < maxEthIn + MIN_ETH_RESERVE) {
    throw new ApiError(
      503,
      "FunderCannotTopUp",
      `need ${formatEther(maxEthIn)} ETH to buy ${formatUnits(need, 6)} USDC but only ` +
        `${formatEther(ethBalance)} ETH is held (keeping ${formatEther(MIN_ETH_RESERVE)} for gas) — top up ${relayerAccount.address}`,
    );
  }

  // Three txs, each simulate-first through the relayer's FIFO queue: wrap, approve, swap.
  await sendRelayerTx({ address: WETH, abi: wethAbi, functionName: "deposit", args: [], value: maxEthIn });
  await sendRelayerTx({
    address: WETH,
    abi: erc20Abi,
    functionName: "approve",
    args: [SWAP_ROUTER, maxEthIn],
  });
  await sendRelayerTx({
    address: SWAP_ROUTER,
    abi: routerAbi,
    functionName: "exactOutputSingle",
    args: [
      {
        tokenIn: WETH,
        tokenOut: config.addresses.realUsdc,
        fee: POOL_FEE,
        recipient: relayerAccount.address,
        amountOut: need,
        amountInMaximum: maxEthIn,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

  return status(
    true,
    `swapped ~${formatEther(quotedEthIn)} ETH for ${formatUnits(need, 6)} USDC ` +
      `(was ${formatUnits(balance, 6)}, target ${formatUnits(TARGET, 6)})`,
  );
}

/**
 * Tops the demo PBM wallet up so the agent beats can run. Admin-gated and
 * cooldown-free, unlike the public payer faucet — the wallet needs enough for
 * one drinks order (S$4.50 ≈ 3.36) AND enough left over for the rejection
 * attempt's balance pre-check, which the facilitator runs before the on-chain
 * policy check. Underfund it and the rejection beat fails as insufficient_funds
 * instead of CategoryNotAllowed, which is the wrong story entirely.
 */
const WALLET_FLOOR = 8_000_000n; // 8 USDC
const WALLET_TARGET = 10_000_000n; // 10 USDC

export async function topUpPbmWallet(): Promise<{ wallet: Address; usdc: string; sent: string }> {
  const wallet = config.demoPbmWallet;
  const balance = await publicClient.readContract({
    address: config.addresses.realUsdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [wallet],
  });
  if (balance >= WALLET_FLOOR) {
    return { wallet, usdc: formatUnits(balance, 6), sent: "0" };
  }

  const send = WALLET_TARGET - balance;
  const funderBalance = await usdcBalance();
  if (funderBalance < send) {
    throw new ApiError(
      503,
      "FunderExhausted",
      `need ${formatUnits(send, 6)} USDC for the PBM wallet but the funder holds ${formatUnits(funderBalance, 6)}`,
    );
  }
  await sendRelayerTx({
    address: config.addresses.realUsdc,
    abi: erc20Abi,
    functionName: "transfer",
    args: [wallet, send],
  });
  return { wallet, usdc: formatUnits(WALLET_TARGET, 6), sent: formatUnits(send, 6) };
}
