"use client";

import { useCallback, useMemo } from "react";
import {
  createWalletClient,
  http,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import { usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import {
  BASE_SEPOLIA_ADDRESSES,
  agentPbmWalletAbi,
  agentPbmWalletFactoryAbi,
} from "@gantry/shared";
import { api, ApiClientError } from "@/lib/api";
import { getDemoAccount } from "@/lib/demo-account";
import { demoKeyMalformed } from "@/lib/env";
import { usePayerIdentity } from "./identity";

/**
 * Agent configuration is signed by the PAYER, not by a server.
 *
 * `setPolicy` and `revoke` are `onlyOwner` and the owner is the payer, so there
 * is no endpoint that can write a policy — that is the point of the screen. It
 * also means these are the only transactions in Gantry the payer pays gas for,
 * which is why `POST /api/faucet/gas` exists: configuring an agent is an owner
 * action, and owners funding their own wallet is normal. Paying a merchant
 * still costs the payer nothing.
 *
 * That route, and never `POST /api/faucet` — the USDC grant is the scarce one
 * and refuses on a ceiling and a cooldown that say nothing about gas.
 */

export interface WalletPolicy {
  dailyCap: bigint;
  perTxCap: bigint;
  /**
   * Absolute unix seconds, and a `number` because the field is `uint40`.
   * Derive it from CHAIN time — a laptop minutes fast would arm a policy that is
   * already dead by the contract's clock.
   */
  expiry: number;
  categoryBitmap: bigint;
}

/**
 * Below this the payer cannot land a single transaction, so the faucet is asked
 * first. Well under the faucet's own 0.002 ETH target: the point is to catch an
 * empty key, not to keep topping one up that is fine.
 */
const GAS_FLOOR = 300_000_000_000_000n; // 0.0003 ETH

/**
 * How long to wait for an owner transaction's receipt.
 *
 * Explicit, because viem's default is three minutes and the payer is holding a
 * phone. Base Sepolia mines in about two seconds, so anything still unconfirmed
 * here is not slow — it is unresolved, which is a different answer and gets a
 * different type below.
 */
const RECEIPT_TIMEOUT_MS = 45_000;

/**
 * `usePublicClient()` returns nothing only when Base Sepolia is missing from the
 * wagmi config — a build-time fact. The message this replaces said "reload the
 * page", which names the one action that can never change it.
 */
const RPC_MISSING =
  "no RPC client for Base Sepolia: this build is misconfigured, and reloading will not change it";

/**
 * The payer's ETH balance, or zero if the read itself fails.
 *
 * This is the PRECHECK for a top-up, not the payment, and it hits the same
 * rate-limited public node as everything else. Letting a blip on it throw aborts
 * a write the account can most likely pay for — the exact opposite of the care
 * taken one step later, where a faucet refusal is deliberately not allowed to
 * abort anything. Zero is the safe unknown: it asks for a top-up, which is
 * refusable and harmless, rather than skipping one that was needed.
 */
async function gasBalance(
  client: { getBalance(args: { address: Address }): Promise<bigint> },
  address: Address,
): Promise<bigint> {
  try {
    return await client.getBalance({ address });
  } catch (err) {
    console.warn("gantry: could not read the gas balance; assuming a top-up is needed", err);
    return 0n;
  }
}

/**
 * The transaction is BROADCAST and its outcome is not known.
 *
 * Distinct from a failure, and never to be rendered as one. Two ways to get
 * here, and neither is a verdict: the wait ran out while the transaction sits in
 * the mempool, or a transaction with the same nonce mined in its place. This is
 * the same split the pay flow draws between `failed` and `unknown`, applied to
 * the writes the payer signs themselves. Revoke is the one that makes it
 * load-bearing — the screen promises that every payment after it reverts, so a
 * red "it failed" over a revoke that lands is that promise inverted in the other
 * direction.
 *
 * Callers must offer no blind retry against it and must re-read the wallet: the
 * chain is the only thing that can settle the question. The `cause` string says
 * which of the two happened; the screens deliberately give the same advice for
 * both, because looking before resending is the safe move either way.
 */
export class UnknownOutcomeError extends Error {
  readonly txHash: Hex;
  /** "revoke", "setPolicy", "createWallet" — what was being sent. */
  readonly what: string;

  constructor(what: string, txHash: Hex, cause: string) {
    super(`${what} was submitted and its outcome is unconfirmed: ${cause}`);
    this.name = "UnknownOutcomeError";
    this.what = what;
    this.txHash = txHash;
  }
}

/**
 * viem RESOLVES a receipt whose `status` is "reverted" — it does not throw.
 *
 * Every write here simulates first, so a revert is rare; but a policy that
 * changed between the simulation and the block, or a gas-limit failure, mines
 * as a reverted transaction and this is the only thing standing between that
 * and the screen reporting success. Revoke is the one that matters: its own
 * copy promises "Every payment after it reverts, and no server can override
 * it", and a revoke reported as done when it was not is that promise inverted.
 * `relayer.ts` does exactly this check for the same reason.
 *
 * The wait itself is bounded and its failure is NOT a revert — see
 * `UnknownOutcomeError`.
 */
function assertMined(what: string, receipt: { status: "success" | "reverted" }, txHash: Hex): void {
  if (receipt.status !== "success") {
    // No decoded reason is available here and none can be: a receipt carries no
    // revert data, and the simulation that WOULD have decoded it passed. Saying
    // that is more useful than a bare hash — it tells the payer the wallet's
    // state moved between the two, which is the only way to get here.
    throw new Error(
      `${what} simulated cleanly but reverted when it mined, so the wallet's state changed in between: ${txHash}`,
    );
  }
}

/** A gas grant this app asked for and did not get. */
interface GasRefusal {
  name: string;
  message: string;
}

/**
 * A nonce that another sender already spent.
 *
 * Only meaningful for the demo account, which CLAUDE.md pins as ONE key shared
 * by every visitor of a deployed build: two people configuring an agent at the
 * same time collide by construction. Matched on the message because these come
 * back as node strings, not as viem error classes — the set is small and stable
 * across the clients Base Sepolia runs.
 */
const NONCE_COLLISION =
  /nonce too low|nonce has already been used|replacement transaction underpriced|already known/i;

/**
 * Re-throws a write's failure with the context only this layer has.
 *
 * Two things get lost otherwise, and both leave the payer reading a true
 * sentence that explains nothing:
 *
 * - **A refused gas top-up.** Proceeding after one is right — the floor that
 *   triggers it sits well under the faucet's target, so a refusal is not proof
 *   the account cannot pay. Losing the REASON is not: the wallet's own words are
 *   viem's `insufficient funds for gas`, which names neither the faucet, nor the
 *   cooldown or budget it refused on, nor that anything was asked for at all.
 * - **A nonce collision on the shared demo key**, which surfaces as a raw node
 *   string that never mentions the one fact that explains it: someone else is
 *   signing as you.
 *
 * The notes go BEFORE the underlying message, because both screens render
 * `err.message` verbatim and a viem message is a multi-line block ending in
 * Request Arguments / Docs / Version — anything appended after that is below the
 * fold. `cause` keeps the original error and its class reachable; flattening it
 * to a string was harmless only while the sole error that got here was a
 * transport-level one, and this file's own bug history is what changed that.
 *
 * An `UnknownOutcomeError` passes through untouched, and must: it carries a type
 * the screens branch on, and a transaction that reached the mempool had its gas
 * — neither note explains anything about it.
 */
function rethrowWithWriteContext(
  err: unknown,
  refusal: GasRefusal | null,
  sharedKey: boolean,
): never {
  if (err instanceof UnknownOutcomeError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  const notes: string[] = [];
  if (sharedKey && NONCE_COLLISION.test(message)) {
    notes.push(
      "This build signs with one shared demo account, so another visitor may be sending from it right now. Wait a moment and try again.",
    );
  }
  if (refusal) {
    notes.push(
      `A gas top-up was requested for this account first and refused (${refusal.name}: ${refusal.message}).`,
    );
  }
  if (notes.length === 0) throw err;
  throw new Error(`${notes.join(" ")}\n\n${message}`, { cause: err });
}

export interface AgentWrites {
  /** Creates the wallet through the permissionless factory and returns the
   * address the `WalletCreated` log reports — never the simulated one.
   *
   * `label` rides in this transaction rather than a `setLabel` after it, so
   * naming an agent at creation costs nothing: creating and arming stay two
   * transactions. It may be empty. */
  createWallet(agentSigner: Address, label: string): Promise<{ wallet: Address; txHash: Hex }>;
  setPolicy(wallet: Address, policy: WalletPolicy): Promise<Hex>;
  /** Renames an EXISTING wallet — its own transaction, since the label lives
   * on-chain and `setPolicy` deliberately does not carry it (that call resets
   * the daily counter, and a rename must never cost the agent its budget). */
  setLabel(wallet: Address, label: string): Promise<Hex>;
  revoke(wallet: Address): Promise<Hex>;
  /** Chain seconds. `setPolicy` expiries and status badges both need it. */
  chainNow(): Promise<number>;
}

export function useAgentWrites(): AgentWrites {
  const { address, demo, connected } = usePayerIdentity();
  const publicClient = usePublicClient();
  const { data: connectedWalletClient } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();

  /** The endpoint the public client reads from, when it is a plain HTTP one, so
   * the demo signer can broadcast to the same place the receipts are read from. */
  const rpcUrl = useMemo(() => {
    const url: unknown = publicClient?.transport?.url;
    return typeof url === "string" ? url : undefined;
  }, [publicClient]);

  /** The signer for owner actions, plus the gas the payer needs to send them.
   * `gasRefusal` is non-null when a top-up was asked for and refused — carried
   * out rather than logged and dropped, so the write's own failure can say why.
   *
   * It returns the CLIENT and no separate account, and that is load-bearing.
   * viem lets an explicit `account` override the client's own, and `parseAccount`
   * reads a bare address as a *json-rpc* account — the signal for "the node holds
   * this key". Handing back `account.address` next to a locally-signing client
   * therefore demoted it silently, and every demo-key write asked an RPC node
   * that holds no keys to sign for it; `sepolia.base.org` answered `unknown
   * account`. One account, definitionally the client's, is what makes that
   * unrepresentable rather than merely documented.
   *
   * The same reasoning is why the connected branch stops pairing wagmi's client
   * with the address from `useAccount()`: those are two subscriptions that update
   * independently, so switching accounts in the wallet opens a window where the
   * new address is sent as an override onto a client still bound to the old one. */
  const signer = useCallback(async (): Promise<{
    client: WalletClient<Transport, Chain, Account>;
    gasRefusal: GasRefusal | null;
  }> => {
    if (!publicClient) throw new Error(RPC_MISSING);
    if (demo) {
      const account = getDemoAccount();
      let gasRefusal: GasRefusal | null = null;
      if ((await gasBalance(publicClient, account.address)) < GAS_FLOOR) {
        // `/api/faucet/gas`, never `/api/faucet`. This caller needs to SEND a
        // transaction, not to pay one, and the USDC route refuses on a ceiling
        // and a cooldown that have nothing to do with gas — a payer who paid
        // thirty seconds ago would have their Revoke aborted by a 429 about
        // USDC. The gas route refuses only in gas vocabulary.
        try {
          await api.faucetGas(account.address);
        } catch (err) {
          // Still wrapped: this route can refuse too (FaucetGasCooldown,
          // FaucetGasInFlight, FaucetGasBudgetExhausted, FunderGasLow). A
          // refusal is not proof the payer cannot pay for this transaction —
          // the floor above is deliberately well under the faucet's target —
          // so the write proceeds and the wallet decides. Re-reading the
          // balance here to make that judgement would be the same stale-read
          // trap: gas can land while a refusal propagates.
          //
          // The reason travels with the attempt rather than dying in the
          // console: it is the only vocabulary that explains a write which then
          // fails for want of gas.
          gasRefusal =
            err instanceof ApiClientError
              ? { name: err.errorName, message: err.message }
              : { name: "NetworkError", message: err instanceof Error ? err.message : String(err) };
          console.warn("gantry: gas top-up refused, sending with the balance on hand", err);
        }
      }
      return {
        // Deliberately the same endpoint the public client reads from. They are
        // the same today only because `getDefaultConfig` passes no `transports`
        // and both fall through to the chain default — but the day one of them
        // is pointed somewhere else, broadcasting and receipt-polling would sit
        // on different providers, and ordinary replica lag between the two would
        // manufacture `UnknownOutcomeError`s that no message would explain.
        client: createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) }),
        gasRefusal,
      };
    }
    if (!connected || !connectedWalletClient || !address) {
      // A malformed key is a build-time fact, not a missing wallet, and telling
      // the payer to connect one sends them at the one thing that cannot help.
      throw new Error(
        demoKeyMalformed()
          ? "NEXT_PUBLIC_DEMO_KEY is set but is not a 0x-prefixed 32-byte key, so the demo account is off. It is inlined at build time: fix the value and rebuild."
          : "connect a wallet to configure an agent",
      );
    }
    if (connectedWalletClient.chain?.id !== baseSepolia.id) {
      await switchChainAsync({ chainId: baseSepolia.id });
    }
    // A connected wallet funds its own gas; nothing was asked for, so there is
    // nothing to report.
    return { client: connectedWalletClient, gasRefusal: null };
  }, [address, demo, connected, connectedWalletClient, publicClient, rpcUrl, switchChainAsync]);

  const chainNow = useCallback(async (): Promise<number> => {
    if (!publicClient) throw new Error(RPC_MISSING);
    const block = await publicClient.getBlock();
    return Number(block.timestamp);
  }, [publicClient]);

  /** Waits for THIS transaction's receipt, bounded.
   *
   * Two things it refuses to call a failure: a wait that ran out, and a receipt
   * that turns out to belong to a different transaction. Both are unresolved
   * outcomes, and only the chain can close them. */
  const confirm = useCallback(
    async (what: string, txHash: Hex): Promise<TransactionReceipt> => {
      if (!publicClient) throw new Error(RPC_MISSING);
      let receipt: TransactionReceipt;
      // Held in an object rather than a `let`: TypeScript's control-flow
      // analysis does not follow assignments made inside a callback, so a plain
      // variable reads back as `null` after the await.
      const replaced: { by: { reason: string; hash: Hex } | null } = { by: null };
      try {
        receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
          timeout: RECEIPT_TIMEOUT_MS,
          // Without this handler viem SILENTLY substitutes a different
          // transaction's receipt. When the hash we sent yields nothing it scans
          // the block for one with the same `from` and `nonce` and resolves with
          // that receipt instead — so `assertMined` would grade a stranger's
          // transaction and we would return a hash that never mined, as success.
          // `createWallet` is worse still: it parses the substitute's logs, so it
          // could hand back someone else's newly deployed wallet.
          //
          // Not exotic here. The demo key is ONE account shared by every visitor
          // of a deployed build, so two people configuring an agent at the same
          // time collide on a nonce by construction.
          onReplaced: (replacement) => {
            replaced.by = { reason: replacement.reason, hash: replacement.transaction.hash };
          },
        });
      } catch (err) {
        throw new UnknownOutcomeError(
          what,
          txHash,
          err instanceof Error ? err.message : String(err),
        );
      }
      if (replaced.by) {
        // Unknown, not failed: ours never mined, and the receipt in hand belongs
        // to a different transaction, so nothing here can say what became of it.
        // The chain is the only thing that can settle it — which is exactly the
        // contract `UnknownOutcomeError` already carries to the screens.
        throw new UnknownOutcomeError(
          what,
          txHash,
          `another transaction with the same nonce mined instead (${replaced.by.reason}: ${replaced.by.hash}). The demo account is shared, so another visitor may have signed over it`,
        );
      }
      assertMined(what, receipt, txHash);
      return receipt;
    },
    [publicClient],
  );

  const createWallet = useCallback(
    async (agentSigner: Address, label: string) => {
      const { client, gasRefusal } = await signer();
      if (!publicClient) throw new Error(RPC_MISSING);
      try {
        const args = [agentSigner, label] as const;
        // Simulate first, as everything that sends in this repo does: a policy or
        // wiring revert surfaces as a decodable error instead of a burnt tx.
        await publicClient.simulateContract({
          address: BASE_SEPOLIA_ADDRESSES.agentPbmFactory,
          abi: agentPbmWalletFactoryAbi,
          functionName: "createWallet",
          args,
          account: client.account,
        });
        const txHash = await client.writeContract({
          address: BASE_SEPOLIA_ADDRESSES.agentPbmFactory,
          abi: agentPbmWalletFactoryAbi,
          functionName: "createWallet",
          args,
          account: client.account,
          chain: baseSepolia,
        });
        const receipt = await confirm("createWallet", txHash);
        // The address comes from the log, not from the simulation: the factory
        // deploys with CREATE, so the simulated address is only correct while the
        // factory's nonce has not moved — and it moves whenever anyone else
        // creates a wallet in the same block.
        const [created] = parseEventLogs({
          abi: agentPbmWalletFactoryAbi,
          eventName: "WalletCreated",
          logs: receipt.logs,
        });
        if (!created) throw new Error("wallet was created but the WalletCreated log was not found");
        // The deploy is mined, but the next call can land on a replica that has
        // not seen the block — and the caller's next move is to simulate
        // `setPolicy` against this address, which fails outright if the code is
        // not there yet. Same lag the payer page waits out before signing.
        //
        // BEST-EFFORT, and it has to stay that way. The receipt above already
        // proved the deploy, and the factory has no idempotency — it pushes a
        // fresh wallet on every call. Throwing here would drop an address that
        // exists on-chain, and the caller would then be holding no wallet at all:
        // its `if (!target)` guard would not engage and the retry would mint a
        // SECOND wallet for the same signer. Returning an address the next call
        // may not see yet is the strictly better failure — that call gets a
        // legible error and the retry arms the wallet that already exists.
        for (let i = 0; i < 8; i++) {
          try {
            if ((await publicClient.getCode({ address: created.args.wallet })) !== undefined) break;
          } catch (err) {
            // The read failed, which says nothing about the deploy. Waiting on a
            // failing endpoint buys nothing either.
            console.warn("gantry: could not confirm the new wallet is visible yet", err);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return { wallet: created.args.wallet, txHash };
      } catch (err) {
        rethrowWithWriteContext(err, gasRefusal, client.account.type === "local");
      }
    },
    [confirm, publicClient, signer],
  );

  const setPolicy = useCallback(
    async (wallet: Address, policy: WalletPolicy) => {
      const { client, gasRefusal } = await signer();
      if (!publicClient) throw new Error(RPC_MISSING);
      try {
        const args = [policy] as const;
        await publicClient.simulateContract({
          address: wallet,
          abi: agentPbmWalletAbi,
          functionName: "setPolicy",
          args,
          account: client.account,
        });
        const txHash = await client.writeContract({
          address: wallet,
          abi: agentPbmWalletAbi,
          functionName: "setPolicy",
          args,
          account: client.account,
          chain: baseSepolia,
        });
        await confirm("setPolicy", txHash);
        return txHash;
      } catch (err) {
        rethrowWithWriteContext(err, gasRefusal, client.account.type === "local");
      }
    },
    [confirm, publicClient, signer],
  );

  const setLabel = useCallback(
    async (wallet: Address, label: string) => {
      const { client, gasRefusal } = await signer();
      if (!publicClient) throw new Error(RPC_MISSING);
      try {
        const args = [label] as const;
        await publicClient.simulateContract({
          address: wallet,
          abi: agentPbmWalletAbi,
          functionName: "setLabel",
          args,
          account: client.account,
        });
        const txHash = await client.writeContract({
          address: wallet,
          abi: agentPbmWalletAbi,
          functionName: "setLabel",
          args,
          account: client.account,
          chain: baseSepolia,
        });
        await confirm("setLabel", txHash);
        return txHash;
      } catch (err) {
        rethrowWithWriteContext(err, gasRefusal, client.account.type === "local");
      }
    },
    [confirm, publicClient, signer],
  );

  const revoke = useCallback(
    async (wallet: Address) => {
      const { client, gasRefusal } = await signer();
      if (!publicClient) throw new Error(RPC_MISSING);
      try {
        await publicClient.simulateContract({
          address: wallet,
          abi: agentPbmWalletAbi,
          functionName: "revoke",
          account: client.account,
        });
        const txHash = await client.writeContract({
          address: wallet,
          abi: agentPbmWalletAbi,
          functionName: "revoke",
          account: client.account,
          chain: baseSepolia,
        });
        await confirm("revoke", txHash);
        return txHash;
      } catch (err) {
        rethrowWithWriteContext(err, gasRefusal, client.account.type === "local");
      }
    },
    [confirm, publicClient, signer],
  );

  return { createWallet, setPolicy, setLabel, revoke, chainNow };
}
