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
/**
 * Hard cap on what a single top-up may spend, independent of what the pool says.
 * MIN_ETH_RESERVE is a floor on what is LEFT, which is not the same guarantee: the
 * input amount comes from a public testnet pool that anyone with faucet ETH can
 * skew, so without a ceiling a moved price could convert several ETH of the only
 * gas key in the system in one `demo:reset`. At the observed ~205 USDC/ETH, 35-50
 * USDC costs ~0.25 ETH; 0.5 ETH leaves room for a real price move while refusing
 * an absurd one.
 */
const MAX_ETH_PER_SWAP = 500_000_000_000_000_000n; // 0.5 ETH

const wethAbi = [
  { type: "function", name: "deposit", inputs: [], outputs: [], stateMutability: "payable" },
  // `withdraw` is not optional hygiene. `exactOutputSingle` pulls only the amount
  // it needs, so the whole slippage buffer stays wrapped after every successful
  // swap — and WETH is not gas. Without this the relayer bleeds its gas key into
  // an asset nothing in the system reads, a few percent at a time, invisibly.
  {
    type: "function",
    name: "withdraw",
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
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
  /** Wrapped ETH held by the funder. Normally "0" — a non-zero value means a
   * previous swap did not finish, and that ETH is not available for gas. */
  weth: string;
  swapped: boolean;
  detail: string;
}

async function wethBalance(): Promise<bigint> {
  return publicClient.readContract({
    address: WETH,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [relayerAccount.address],
  });
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
  const [eth, usdc, weth] = await Promise.all([
    publicClient.getBalance({ address: relayerAccount.address }),
    usdcBalance(),
    wethBalance(),
  ]);
  return {
    funder: relayerAccount.address,
    eth: formatEther(eth),
    usdc: formatUnits(usdc, 6),
    weth: formatEther(weth),
    swapped,
    detail,
  };
}

export async function topUpFunder(): Promise<FunderStatus> {
  const balance = await usdcBalance();
  if (balance >= FLOOR) {
    // Reclaim any wrapped ETH even when no swap is due. Otherwise a surplus left
    // by an older run sits out of reach of gas until USDC next drops below the
    // floor, which could be days — and it is the gas key.
    const idle = await wethBalance();
    if (idle > 0n) {
      await sendRelayerTx({ address: WETH, abi: wethAbi, functionName: "withdraw", args: [idle] });
      return status(false, `USDC above the ${formatUnits(FLOOR, 6)} floor — unwrapped ${formatEther(idle)} stranded WETH`);
    }
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
  if (maxEthIn > MAX_ETH_PER_SWAP) {
    throw new ApiError(
      503,
      "FunderQuoteImplausible",
      `the pool wants ${formatEther(maxEthIn)} ETH for ${formatUnits(need, 6)} USDC, above the ` +
        `${formatEther(MAX_ETH_PER_SWAP)} ETH per-swap cap — the WETH/USDC pool has probably been ` +
        `skewed. Refusing to convert the gas key; buy USDC manually or raise MAX_ETH_PER_SWAP.`,
    );
  }

  // Reuse whatever a previous partial run left wrapped before wrapping more.
  // Without this, a swap that fails after the deposit makes every retry wrap
  // another maxEthIn on top of ETH that would already have covered the trade —
  // the gas key walks down in maxEthIn-sized steps while USDC never moves.
  const stranded = await wethBalance();
  const toWrap = maxEthIn > stranded ? maxEthIn - stranded : 0n;

  const ethBalance = await publicClient.getBalance({ address: relayerAccount.address });
  if (ethBalance < toWrap + MIN_ETH_RESERVE) {
    throw new ApiError(
      503,
      "FunderCannotTopUp",
      `need ${formatEther(toWrap)} ETH to buy ${formatUnits(need, 6)} USDC but only ` +
        `${formatEther(ethBalance)} ETH is held (keeping ${formatEther(MIN_ETH_RESERVE)} for gas)` +
        (stranded > 0n
          ? ` — note ${formatEther(stranded)} WETH is already held and will be reused`
          : ` — top up ${relayerAccount.address}`),
    );
  }

  let spentEth = quotedEthIn;
  try {
    // Simulate-first through the relayer's FIFO queue: wrap, approve, swap.
    if (toWrap > 0n) {
      await sendRelayerTx({ address: WETH, abi: wethAbi, functionName: "deposit", args: [], value: toWrap });
    }
    await sendRelayerTx({
      address: WETH,
      abi: erc20Abi,
      functionName: "approve",
      args: [SWAP_ROUTER, maxEthIn],
    });
    // `result` is the router's own amountIn — the amount actually paid, rather
    // than the pre-slippage quote we used to guess. Report the truth.
    const swap = await sendRelayerTx({
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
    if (typeof swap.result === "bigint") spentEth = swap.result;
  } catch (err) {
    // The compensation invariant: the helper throwing does NOT prove the tx did
    // not happen, and here it also does not prove the earlier txs did not. Read
    // the chain and say exactly what the funder is holding, because the wrapped
    // ETH is invisible in an ETH balance and the old error pointed the operator
    // at "top up this address" when the ETH was already there, as WETH.
    const after = await status(false, "").catch(() => null);
    console.error(
      `funder CRITICAL: the ETH→USDC swap failed mid-sequence. ` +
        (after
          ? `Funder now holds ${after.eth} ETH · ${after.usdc} USDC · ${after.weth} WETH. `
          : `Chain state unreadable. `) +
        `Re-running demo:reset resumes (it reuses stranded WETH); the swap MAY have landed if ` +
        `this was a receipt timeout.`,
      err,
    );
    throw new ApiError(
      503,
      "FunderSwapIncomplete",
      after
        ? `swap did not complete — funder holds ${after.eth} ETH, ${after.usdc} USDC and ` +
          `${after.weth} WETH. Re-run to resume; the swap may have landed if the receipt timed out.`
        : `swap did not complete and the chain state could not be read — check ${relayerAccount.address}`,
    );
  }

  // Unwrap the slippage buffer so it is gas again rather than dead weight. The
  // allowance left behind is harmless against a zero balance and the next swap
  // re-approves, so this is the only cleanup tx worth a receipt wait.
  const surplus = await wethBalance();
  if (surplus > 0n) {
    await sendRelayerTx({ address: WETH, abi: wethAbi, functionName: "withdraw", args: [surplus] });
  }

  return status(
    true,
    `swapped ${formatEther(spentEth)} ETH for ${formatUnits(need, 6)} USDC ` +
      `(was ${formatUnits(balance, 6)}, target ${formatUnits(TARGET, 6)}` +
      (stranded > 0n ? `, reused ${formatEther(stranded)} stranded WETH` : "") +
      (surplus > 0n ? `, unwrapped ${formatEther(surplus)} WETH` : "") +
      ")",
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

/** Replica lag after a confirmed transfer, bounded — see topUpPbmWallet. */
const BALANCE_LAG_RETRIES = 5;
const BALANCE_LAG_DELAY_MS = 1_000;

function readWalletBalance(wallet: Address): Promise<bigint> {
  return publicClient.readContract({
    address: config.addresses.realUsdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [wallet],
  });
}

export async function topUpPbmWallet(): Promise<{ wallet: Address; usdc: string; sent: string }> {
  const wallet = config.demoPbmWallet;
  const balance = await readWalletBalance(wallet);
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
  const { receipt } = await sendRelayerTx({
    address: config.addresses.realUsdc,
    abi: erc20Abi,
    functionName: "transfer",
    args: [wallet, send],
  });
  // Re-read rather than returning WALLET_TARGET. The arithmetic is exact only if
  // nothing else touched the wallet, and demo:reset routinely runs while a
  // rehearsal settlement is in flight — reporting a computed target as an
  // observed balance is wrong in exactly the direction that matters, right before
  // the beat whose failure mode is insufficient_funds.
  //
  // Bounded lag-retry, same class the facilitator already retries: a balance read
  // straight after a confirmed transfer can still land on a replica that has not
  // seen it, which reports the PRE-transfer figure and (worse) fires the
  // shortfall warning below on a wallet that is actually full.
  const expected = balance + send;
  let after = await readWalletBalance(wallet);
  for (let attempt = 0; after < expected && attempt < BALANCE_LAG_RETRIES; attempt++) {
    await new Promise((r) => setTimeout(r, BALANCE_LAG_DELAY_MS));
    after = await readWalletBalance(wallet);
  }
  if (after < WALLET_FLOOR) {
    console.error(
      `funder CRITICAL: the PBM wallet is still below the ${formatUnits(WALLET_FLOOR, 6)} floor ` +
        `(${formatUnits(after, 6)} USDC) after a CONFIRMED transfer in ${receipt.transactionHash} — ` +
        `concurrent outflow? The rejection beat will fail as insufficient_funds.`,
    );
  }
  return { wallet, usdc: formatUnits(after, 6), sent: formatUnits(send, 6) };
}
