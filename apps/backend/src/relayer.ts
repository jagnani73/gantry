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
    const hash = await walletClient.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== "success") {
      throw new Error(`relayer tx reverted on-chain: ${hash}`);
    }
    return { receipt, result };
  });
}
