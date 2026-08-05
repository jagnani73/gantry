import type { Abi, Address, ContractFunctionArgs, ContractFunctionName, TransactionReceipt } from "viem";
import { publicClient, walletClient, relayerAccount } from "./chain";

/**
 * Serial FIFO queue around every relayer write: the relayer key is the only
 * gas key, and serialization makes nonce handling trivial (fresh per tx) and
 * immune to desync after reverts. Demo throughput never needs parallelism.
 */
let tail: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(job, job);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export interface RelayedTx<T> {
  receipt: TransactionReceipt;
  /** simulateContract's return value (e.g. createIntent's intentId). */
  result: T;
}

/**
 * The queue owns the relayer nonce. RPC nodes can lag right after a tx mines,
 * so getTransactionCount alone races itself ("replacement tx underpriced");
 * a local counter, resynced on failure, is deterministic.
 */
let nextNonce: number | null = null;

async function claimNonce(): Promise<number> {
  if (nextNonce === null) {
    nextNonce = await publicClient.getTransactionCount({
      address: relayerAccount.address,
      blockTag: "pending",
    });
  }
  return nextNonce;
}

function isNonceRace(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /nonce|underpriced|replacement|already known/i.test(message);
}

/** simulate → write → wait 1 conf, serialized. Simulation reverts surface as decodable viem errors. */
export function sendRelayerTx<
  const TAbi extends Abi,
  TFunctionName extends ContractFunctionName<TAbi, "nonpayable" | "payable">,
>(params: {
  address: Address;
  abi: TAbi;
  functionName: TFunctionName;
  args: ContractFunctionArgs<TAbi, "nonpayable" | "payable", TFunctionName>;
}): Promise<RelayedTx<unknown>> {
  return enqueue(async () => {
    const { request, result } = await publicClient.simulateContract({
      account: relayerAccount,
      address: params.address,
      abi: params.abi,
      functionName: params.functionName,
      args: params.args,
    } as Parameters<typeof publicClient.simulateContract>[0]);

    let hash: `0x${string}`;
    try {
      hash = await walletClient.writeContract({ ...request, nonce: await claimNonce() });
    } catch (err) {
      if (!isNonceRace(err)) {
        nextNonce = null;
        throw err;
      }
      nextNonce = null; // resync once and retry
      hash = await walletClient.writeContract({ ...request, nonce: await claimNonce() });
    }
    nextNonce = (nextNonce ?? 0) + 1;

    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== "success") {
      throw new Error(`relayer tx reverted on-chain: ${hash}`);
    }
    return { receipt, result };
  });
}
