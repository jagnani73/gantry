import { decodeGantryError, describeGantryError, type DecodedGantryError } from "@gantry/shared";
import { ApiClientError } from "./api";

/**
 * Chain and wallet errors, said in a sentence.
 *
 * Every screen that signs something used to render `err.message` verbatim, and
 * for a viem error that is a multi-line block — the sentence, then Request
 * Arguments, the contract address, the calldata, a docs URL and a version
 * string. A payer who declined a prompt got sixteen lines of machine detail to
 * learn that they had declined a prompt.
 *
 * Two rules this follows, both from how the rest of the app treats errors:
 *
 * - **Nothing is thrown away.** `detail` always carries the underlying text and
 *   callers log it; the screen shows `headline` and may offer `detail` behind a
 *   disclosure. Shortening is a presentation choice, not a decision to know
 *   less.
 * - **A contract's own error name travels verbatim.** `CategoryNotAllowed` is
 *   the fact; a friendlier sentence may sit ALONGSIDE it, never instead of it.
 *   That rule already governs the agent denial receipts and it applies just as
 *   well to a write that reverts in front of the payer.
 */

/**
 * A write failure plus the context only the calling layer had.
 *
 * The notes are things the wallet's own message cannot say — that a gas top-up
 * was asked for and refused, or that this build signs with one shared demo
 * account so another visitor may have taken the nonce. They are carried as
 * DATA rather than concatenated into the message, because the display layer
 * shortens the underlying error and a string-prepended note would either be cut
 * with it or block the classification that shortens it.
 */
export class WriteContextError extends Error {
  readonly notes: readonly string[];

  constructor(notes: readonly string[], cause: unknown) {
    super(notes.join(" "), { cause });
    this.name = "WriteContextError";
    this.notes = notes;
  }
}

export interface WriteErrorText {
  /** One sentence for the screen. Never empty. */
  headline: string;
  /** The underlying message, for the console and an optional details view.
   * Empty when it would only repeat the headline. */
  detail: string;
  /** True when the wallet refused before anything was broadcast, so nothing
   * happened on-chain and saying so is safe. */
  rejected: boolean;
}

/** A wallet declining to sign. Matched on text as well as by class: the string
 * comes back from the provider and the wrapping class varies by connector. */
const REJECTED = /user rejected|user denied|rejected the request|denied transaction/i;
/**
 * Not enough NATIVE token for gas, in the wallet's own words.
 *
 * Deliberately specific. A looser `/insufficient funds|exceeds the balance/`
 * also matches an ERC-20 revert ("ERC20: transfer amount exceeds balance"),
 * which is a token balance and has nothing to do with gas — so a payer short of
 * USDC would have been told to top up their ETH. viem's gas message is "The
 * total cost … exceeds the balance of the account"; nodes say "insufficient
 * funds for gas * price + value".
 */
const NO_GAS = /insufficient funds for|exceeds the balance of the account|gas required exceeds/i;
/** The wallet is pointed at another network. */
const WRONG_CHAIN = /chain mismatch|does not match the target chain|unsupported chain|chain not configured/i;

/** Explanations that sit beside a contract's own error name, never replacing
 * it. Only the ones a payer or merchant can actually act on — an unlisted name
 * still renders, just without a gloss. */
const CONTRACT_HINT: Record<string, string> = {
  CategoryNotAllowed: "this agent's policy does not allow that kind of shop",
  PerTxCapExceeded: "the payment is over this agent's per-payment cap",
  DailyCapExceeded: "this agent has spent its daily allowance",
  PolicyExpired: "this agent's policy has expired or been revoked",
  InsufficientWalletBalance: "the agent wallet does not hold enough to pay",
  NotMerchantPayout: "only the address currently being paid can make this change",
  MerchantNotFound: "no shop is registered under that handle",
  ZeroAddress: "that address is all zeroes, which the contract refuses",
  HandleTaken: "that handle is already registered",
  OwnershipCannotBeRenounced: "this wallet cannot be left without an owner",
};

function fromDecoded(decoded: DecodedGantryError): string {
  if (decoded.kind === "custom") {
    const hint = CONTRACT_HINT[decoded.name];
    // The name first and always. The gloss is an aid, not a translation.
    return hint ? `${decoded.name}: ${hint}.` : `The contract refused this: ${decoded.name}.`;
  }
  if (decoded.kind === "string") return decoded.reason;
  return decoded.message;
}

export function describeWriteError(err: unknown): WriteErrorText {
  // Notes first, then whatever the wallet said, shortened. The notes explain
  // the failure; the underlying error only names it.
  if (err instanceof WriteContextError) {
    const inner = describeWriteError(err.cause);
    return {
      headline: [...err.notes, inner.headline].join(" "),
      detail: inner.detail,
      rejected: inner.rejected,
    };
  }

  // An API error is already written for a person to read — the backend owns
  // that vocabulary and this must not paraphrase it.
  if (err instanceof ApiClientError) {
    return { headline: err.message, detail: "", rejected: false };
  }

  const raw = err instanceof Error ? err.message : String(err);

  if (REJECTED.test(raw)) {
    return {
      // Provable, not a guess: the wallet refuses before broadcasting, so there
      // is no transaction to be unsure about.
      headline: "You declined this in your wallet, so nothing was sent.",
      detail: "",
      rejected: true,
    };
  }
  if (NO_GAS.test(raw)) {
    return {
      headline:
        "This account does not have enough Base Sepolia ETH to pay for the transaction. Nothing was sent.",
      detail: raw,
      rejected: false,
    };
  }
  if (WRONG_CHAIN.test(raw)) {
    return {
      headline: "Your wallet is on a different network. Switch it to Base Sepolia and try again.",
      detail: raw,
      rejected: false,
    };
  }

  // `decodeGantryError` walks a viem error to the revert and decodes custom
  // errors against the union; for anything else it returns viem's SHORT
  // message, which is the first line rather than the whole block.
  const decoded = decodeGantryError(err);
  const headline = fromDecoded(decoded);
  return {
    headline: headline.trim() === "" ? "That didn't go through." : headline,
    // Only when it adds something. Repeating the headline under itself is the
    // noise this function exists to remove.
    detail: raw.trim() === headline.trim() ? "" : raw,
    rejected: false,
  };
}

/** The one-line form, for callers with nowhere to put `detail`. */
export function writeErrorHeadline(err: unknown): string {
  return describeWriteError(err).headline;
}

export { describeGantryError };
