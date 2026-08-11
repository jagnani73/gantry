import type { Hex, PublicClient, TransactionReceipt } from "viem";

/**
 * Waiting for a transaction this browser sent, without lying about the answer.
 *
 * Extracted from the payer's agent writes when the merchant's payout rotation
 * became the second browser-signed write in the app. It is the same three
 * hazards either way, and each one produced a real bug before it was handled:
 * viem resolves a REVERTED receipt rather than throwing, it silently substitutes
 * a different transaction's receipt when the hash it was given yields nothing,
 * and its default wait is three minutes long.
 */

/**
 * How long to wait for a receipt.
 *
 * Explicit, because viem's default is three minutes and there is a person
 * holding a phone. Base Sepolia mines in about two seconds, so anything still
 * unconfirmed here is not slow — it is unresolved, which is a different answer
 * and gets a different type below.
 */
const RECEIPT_TIMEOUT_MS = 45_000;

/**
 * Every write this app signs in a browser.
 *
 * A closed union rather than `string`, because screens branch on it to decide
 * what to tell the payer about an unresolved transaction, and the alternative
 * has already shipped a wrong sentence once: `unresolvedText` fell through to
 * the policy sentence when `setLabel` arrived, and told the payer the wrong
 * transaction was unresolved. A comment listing the names could not prevent
 * that; a union plus an exhaustive `switch` makes adding an eighth write a
 * compile error at exactly the line that would otherwise lie.
 *
 * It costs this generic module a little knowledge of the app's vocabulary. That
 * dependency already existed — the doc comment enumerated all seven names in
 * prose — so this makes existing coupling checkable rather than adding any.
 */
export type WriteName =
  | "createWallet"
  | "setPolicy"
  | "setLabel"
  | "setAgentSigner"
  | "revoke"
  | "withdraw"
  | "setMerchantPayout";

/**
 * The transaction is BROADCAST and its outcome is not known.
 *
 * Distinct from a failure, and never to be rendered as one. Two ways to get
 * here, and neither is a verdict: the wait ran out while the transaction sits in
 * the mempool, or a transaction with the same nonce mined in its place. This is
 * the same split the pay flow draws between `failed` and `unknown`, applied to
 * the writes a user signs themselves. Revoke is the one that makes it
 * load-bearing — the screen promises that every payment after it reverts, so a
 * red "it failed" over a revoke that lands is that promise inverted in the other
 * direction.
 *
 * Callers must offer no blind retry against it and must re-read the chain: it is
 * the only thing that can settle the question. The `cause` string says which of
 * the two happened; the screens deliberately give the same advice for both,
 * because looking before resending is the safe move either way.
 */
export class UnknownOutcomeError extends Error {
  readonly txHash: Hex;
  /** What was being sent. Closed, so the screens that branch on it are
   * exhaustiveness-checked — see `WriteName`. */
  readonly what: WriteName;

  constructor(what: WriteName, txHash: Hex, cause: string) {
    super(`${what} was submitted and its outcome is unconfirmed: ${cause}`);
    this.name = "UnknownOutcomeError";
    this.what = what;
    this.txHash = txHash;
  }
}

/**
 * viem RESOLVES a receipt whose `status` is "reverted" — it does not throw.
 *
 * Every write here simulates first, so a revert is rare; but state that changed
 * between the simulation and the block, or a gas-limit failure, mines as a
 * reverted transaction and this is the only thing standing between that and the
 * screen reporting success. Revoke is the one that matters: its own copy
 * promises "Every payment after it reverts, and no server can override it", and
 * a revoke reported as done when it was not is that promise inverted.
 * `relayer.ts` does exactly this check for the same reason.
 */
function assertMined(
  what: WriteName,
  receipt: { status: "success" | "reverted" },
  txHash: Hex,
): void {
  if (receipt.status !== "success") {
    // No decoded reason is available here and none can be: a receipt carries no
    // revert data, and the simulation that WOULD have decoded it passed. Saying
    // that is more useful than a bare hash — it tells the user the chain's state
    // moved between the two, which is the only way to get here.
    throw new Error(
      `${what} simulated cleanly but reverted when it mined, so the chain's state changed in between: ${txHash}`,
    );
  }
}

/**
 * Waits for THIS transaction's receipt, bounded.
 *
 * Two things it refuses to call a failure: a wait that ran out, and a receipt
 * that turns out to belong to a different transaction. Both are unresolved
 * outcomes, and only the chain can close them.
 *
 * `sharedKey` only changes the wording — on a build signing with one shared demo
 * account, a nonce collision is routine rather than exotic and saying so is the
 * difference between a mystifying message and an obvious one.
 */
export async function confirmTx(
  publicClient: Pick<PublicClient, "waitForTransactionReceipt">,
  what: WriteName,
  txHash: Hex,
  sharedKey = false,
): Promise<TransactionReceipt> {
  let receipt: TransactionReceipt;
  // Held in an object rather than a `let`: TypeScript's control-flow analysis
  // does not follow assignments made inside a callback, so a plain variable
  // reads back as `null` after the await.
  const replaced: { by: { reason: string; hash: Hex } | null } = { by: null };
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: RECEIPT_TIMEOUT_MS,
      // Without this handler viem SILENTLY substitutes a different
      // transaction's receipt. When the hash we sent yields nothing it scans the
      // block for one with the same `from` and `nonce` and returns that receipt
      // instead — so `assertMined` would grade a stranger's transaction, and we
      // would return a hash that never mined, as success. `createWallet` is
      // worse still: it parses the substitute's logs, so it could hand back
      // someone else's newly deployed wallet.
      //
      // Not exotic on the payer side. The demo key is ONE account shared by
      // every visitor of a deployed build, so two people configuring an agent at
      // the same time collide on a nonce by construction.
      onReplaced: (replacement) => {
        replaced.by = { reason: replacement.reason, hash: replacement.transaction.hash };
      },
    });
  } catch (err) {
    throw new UnknownOutcomeError(what, txHash, err instanceof Error ? err.message : String(err));
  }
  if (replaced.by) {
    // Unknown, not failed: ours never mined, and the receipt in hand belongs to
    // a different transaction, so nothing here can say what became of it. The
    // chain is the only thing that can settle it — which is exactly the contract
    // `UnknownOutcomeError` already carries to the screens.
    throw new UnknownOutcomeError(
      what,
      txHash,
      `another transaction with the same nonce mined instead (${replaced.by.reason}: ${replaced.by.hash})${
        sharedKey ? ". The demo account is shared, so another visitor may have signed over it" : ""
      }`,
    );
  }
  assertMined(what, receipt, txHash);
  return receipt;
}
