import type { Abi, Address, ContractFunctionArgs, ContractFunctionName, TransactionReceipt } from "viem";
import { publicClient, walletClient, relayerAccount } from "./chain";
import { createFifoQueue } from "./queue";

/**
 * Serial FIFO queue around every relayer write: the relayer key is the only
 * gas key, and serialization makes nonce handling trivial (a single owned
 * counter, resynced on failure) and immune to desync after reverts. Demo
 * throughput never needs parallelism.
 */
const enqueue = createFifoQueue();

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

    let receipt: TransactionReceipt;
    try {
      // Base blocks every ~2s — a 20s cap bounds head-of-line blocking; the
      // default 180s would wedge the whole queue behind one stuck tx.
      receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: 20_000,
      });
    } catch (err) {
      // The tx may or may not still mine — resync the nonce before the next
      // job instead of building on a possibly-missing nonce forever.
      nextNonce = null;
      throw err;
    }
    if (receipt.status !== "success") {
      throw new Error(`relayer tx reverted on-chain: ${hash}`);
    }
    return { receipt, result };
  });
}
