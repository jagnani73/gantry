"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { erc20Abi, type Address } from "viem";
import { usePublicClient } from "wagmi";
import {
  BASE_SEPOLIA_ADDRESSES,
  DISPLAY_CURRENCIES,
  fixedRateSwapAbi,
  isDisplayCurrencyCode,
  settlementSendToken,
  tokenAddress,
  type AgentSummary,
  type DenialEvent,
  type DisplayCurrency,
  type DisplayCurrencyCode,
  type MerchantResponse,
  type SettlementEvent,
  type TokenId,
} from "@gantry/shared";
import { api, ApiClientError } from "@/lib/api";
import {
  policyFingerprint,
  provenAgentFields,
  type ExpectedAgentState,
} from "./agent-rules";
import { findActivityRow, toActivityRows, type ActivityRow } from "./activity";
import { usePayerIdentity, type PayerIdentity } from "./identity";
import {
  OVERLAY_PARAMS,
  namesAnOverlay,
  overlayFromQuery,
  overlayToQuery,
  receiptQuery,
} from "./overlay-url";

/**
 * The payer app's one store.
 *
 * It lives in a provider rather than in each screen because the four tabs read
 * the same three fetches — a wallet's Recent rows and an Activity day group are
 * the same settlements, and the Activity filter needs the agent list the Agents
 * tab renders. Fetching per screen would triple the round trips on a venue
 * hotspot and let two tabs disagree about what the payer has spent.
 */

export type Overlay =
  | { kind: "scan" }
  /** `amount` is a merchant's asking price arriving from a charge link. Absent
   * on the printed standee, which names a shop and never a price. */
  | { kind: "pay"; handle: string; amount?: string }
  | { kind: "receipt"; row: ActivityRow }
  | { kind: "merchant"; handle: string }
  | { kind: "agent"; wallet: Address }
  /** null = create a new agent; an address = edit that wallet's rules.
   * `addCategory` arrives from a refusal the payer is fixing: it ticks that
   * category on top of what is on-chain, so the way out of a denial is one tap
   * rather than a hunt through the list. It is a starting value only — the form
   * still reads the wallet itself and the payer still confirms. */
  | { kind: "agentForm"; wallet: Address | null; addCategory?: number };

/**
 * A receipt asked for by URL, before its row is in hand.
 *
 * Exported so the screen that renders it imports this shape rather than
 * re-declaring it structurally — the two spellings drifted the moment a third
 * status was added, and the compiler had nothing to say about it.
 *
 * `unavailable` is the one that has to exist. `missing` is a claim about this
 * wallet's history, and only a COMPLETED read can support it; a read that failed
 * is not evidence a payment does not exist. Collapsing the two put the headline
 * "That payment isn't in this wallet's history" over a backend that never
 * answered.
 */
export type PendingReceiptState = {
  key: string;
  status: "loading" | "missing" | "unavailable";
};

/**
 * A write this browser watched mine, held until a read agrees with it.
 *
 * Two halves, and both are needed. `fingerprint` answers "has the read caught
 * up"; `proven` is what to SHOW while it has not — because a mined receipt
 * outranks a lagging read, the same rule the merchant payout rotation follows.
 *
 * Before `proven` existed the agents list rendered `Saving…` in place of the
 * name for as long as the read stayed behind, which was wrong twice over: the
 * save had already finished (it is the read that is late, not the write), and
 * nothing bounded the wait, because the give-up rule lives with the poller and
 * the list had none. There is nothing to bound now — the row shows what the
 * chain holds. (The list DOES poll since the live tick landed, but that tick
 * waits on nothing and gives up on nothing; the bounded wait is still the
 * detail screen's.)
 */
export interface AgentExpectation {
  fingerprint: string;
  proven: ReturnType<typeof provenAgentFields>;
  /** When the write was recorded, so the overlay can give up. See `EXPECTATION_TTL_MS`. */
  at: number;
}

/**
 * How long a receipt may outrank a read.
 *
 * The overlay has no other exit: only `AgentDetail` settles an expectation, and
 * a save reached by URL (`?edit=0x…`) pops an emptied stack straight to `/app`
 * without ever mounting it. The entry then lives for the session — inert while
 * the read agrees, and silently reactivating the moment the wallet changes from
 * anywhere else, which on a build where every visitor shares one demo key and
 * `demo:reset` re-arms wallets is an ordinary event rather than an exotic one.
 * The worst shape of that is a **Revoked chip with Revoke disabled over a live
 * wallet**, because `agentStatus` reads the overlaid row.
 *
 * Sized against the detail screen's own give-up (6 × 1.2s) with room for a
 * replica several blocks behind. Past it the read wins: it may be stale, but a
 * stale read is a stale read, whereas an expectation nothing can clear is an
 * assertion with no expiry.
 */
const EXPECTATION_TTL_MS = 60_000;

export interface PayerStore {
  identity: PayerIdentity;

  /**
   * null means NOT KNOWN — still loading, or the enumeration failed (check
   * `agentsError` to tell those apart). An empty array is the stronger claim:
   * we asked, and this payer owns none.
   *
   * Never collapse a failure into `[]`. Beyond the agents screen, this list also
   * widens the history filter, and a PBM payment's on-chain payer is the wallet
   * — so `[]` narrows Activity to the human address and drops every agent
   * payment from a request that otherwise succeeded.
   */
  agents: AgentSummary[] | null;
  agentsError: string | null;
  /** Wallets the payer owns that hold code but did not answer the read. NOT the
   * same as "no agents": a screen that drops these renders "You don't have an
   * agent yet" beside a Create button for a payer who has one, which is how a
   * second wallet gets deployed for one signer. Empty is the normal case. */
  agentsUnreadable: Address[];
  settlements: SettlementEvent[] | null;
  settlementsError: string | null;
  denials: DenialEvent[];
  /** The refusal pages failed to load. Declined rows are additive, so a working
   * history still renders — but the ONLY record a refused agent payment leaves
   * is that row, so its absence can never be silent. */
  denialsError: string | null;
  /** Settlements and refusals merged, newest first. */
  rows: ActivityRow[];

  /** Payer's balance of `sendToken` in 6dp units; null until the read lands.
   * Follows the pay currency, so switching to euros re-reads EURC. */
  balance: bigint | null;
  /** Non-null when the balance READ failed, which is not the same as "not yet"
   * — a screen showing "reading balance…" off `balance === null` alone spins
   * forever on a dead RPC. */
  balanceError: string | null;
  /** OWNER-SET XSGD-per-`sendToken` rate from FixedRateSwap; null if the read
   * failed — in which case no S$ conversion may be rendered at all. It is the
   * rate for the CHOSEN token, so it changes with the pay currency. */
  rate: bigint | null;
  /** Non-null when the rate READ failed. Every S$ figure in the app is this
   * conversion, so a silent failure quietly restates the whole product in the
   * pay token. */
  rateError: string | null;
  /**
   * The currency the payer PAYS IN — never what the merchant receives.
   *
   * A shop is always paid XSGD: `GantryCore`'s XSGD is `immutable`, so the
   * settlement asset cannot differ by screen or by payer. What this changes is
   * the payer's side of the trade: the token on the authorization, the balance
   * read, and the asset the intent is quoted in.
   *
   * Only ever a settleable currency. `setPayCurrency` refuses anything else, so
   * consumers may assume `sendToken` names a token that exists and is payable.
   */
  payCurrency: DisplayCurrency;
  setPayCurrency(code: DisplayCurrencyCode): void;
  /**
   * Has the stored preference been read, or is `payCurrency` still the default?
   *
   * Exposed because a CONTROL has to gate on it. The value above starts at USD
   * on both sides of hydration and the stored choice arrives in an effect, so a
   * euro payer watched the selection jump USD → EUR on every load — the picker
   * was stating an answer it did not have yet. The two chain reads in this
   * provider already gate on this internally; nothing was carrying it to the UI.
   *
   * Same rule as `identity.ready` one card above it on the settings screen:
   * defaulting before the read is a claim, not a default.
   */
  payCurrencyReady: boolean;
  /** The token `payCurrency` resolves to — what a signature will name. */
  sendToken: TokenId;
  /**
   * Whether a balance change this app just caused has actually shown up.
   *
   * - `idle` — nothing is being waited for.
   * - `watching` — a transfer is mined and the figure has not moved yet.
   * - `unconfirmed` — the bounded poll ran out and it STILL has not moved.
   *
   * The third is the one that has to exist. Both of the poll's exits used to be
   * the same silent `return`, so "the top-up arrived" and "we gave up looking
   * for it" were indistinguishable on screen — which is exactly the failure the
   * poll was added to stop being silent.
   */
  balanceWatch: BalanceWatch;

  /** Unix seconds on CHAIN time, not the laptop's. */
  chainNow(): number;

  /**
   * Three answers, not two: `undefined` is "still looking OR the lookup failed",
   * `null` is "the chain has no such handle". A screen that collapses them shows
   * "shop not found" for the half second before the lookup lands — and, worse,
   * shows it forever for a merchant whose lookup timed out. `null` is a CHAIN
   * FACT and nothing else may produce it; ask `merchantError` to tell the two
   * halves of `undefined` apart.
   */
  merchant(handle: string): MerchantResponse | null | undefined;
  ensureMerchant(handle: string): void;
  /** The lookup for this handle failed (network, timeout, 5xx). Never set for a
   * 404 — that is an answer, not a failure. */
  merchantError(handle: string): string | null;
  /** Drops the dedupe entry and looks the handle up again. A failed lookup
   * releases the handle rather than caching itself as "no such shop", and this
   * is how a screen offers the retry — the merchant id is resolved server-side
   * when an intent is created, so the pay flow deliberately still lets the payer
   * pay a shop whose DISPLAY record it could not read. */
  retryMerchant(handle: string): void;

  /**
   * The wallet's on-chain label, or null when it has none.
   *
   * It was a localStorage map until 10 Aug 2026, which meant a name typed on the
   * laptop was invisible on the phone — and on a build where every visitor shares
   * one demo key, that is the same payer looking at the same wallet under two
   * different names. `AgentPBMWallet.label` is the single source now; renaming is
   * an owner transaction like every other change to a wallet.
   */
  agentName(wallet: Address): string | null;

  /**
   * What this browser WROTE and has not yet read back.
   *
   * `setPolicy` and `revoke` are confirmed by a mined receipt in the browser,
   * and then read back through the backend — whose RPC provider is a different
   * endpoint from the one the receipt was confirmed against. A read issued right
   * after the block is routinely answered by a replica that has not seen it, so
   * the payer is returned to a screen still showing the rules they just changed.
   * That is indistinguishable from the write having done nothing.
   *
   * Holding the expectation here rather than in a screen is what lets it survive
   * the overlay unmounting: the form writes it, and the detail screen that opens
   * afterwards is a different component instance.
   */
  agentExpectation(wallet: Address): AgentExpectation | null;
  /** Whether `agents` is answering for this wallet from a mined receipt rather
   * than from the backend's read. For SAYING so and nothing else — the values
   * are true either way. */
  agentAhead(wallet: Address): boolean;
  /** Record what was just written — the STATE, not a digest of it. The store
   * derives the fingerprint, so what a screen renders while it waits and what
   * the wait compares against cannot be built from different fields. Cleared by
   * `settleAgentExpectation`. */
  expectAgentPolicy(wallet: Address, written: ExpectedAgentState, policyWritten: boolean): void;
  /** Stop waiting: the read matched, or the wait was given up on. Both are
   * "no longer expecting", and neither is a claim about the chain.
   *
   * Pass `settledBy` when the read that ended the wait MATCHED the expectation —
   * it replaces that wallet's row in `agents` in the same update, so the guard
   * and the data can never be cleared apart. Omit it when giving up: a read
   * already known to be stale must not be promoted into shared state. */
  settleAgentExpectation(wallet: Address, settledBy?: AgentSummary): void;

  /** Re-reads everything, agent enumeration included. For a policy write. */
  refresh(): void;
  /** Re-reads only the settlement and denial pages. For a payment, which cannot
   * have changed which wallets the payer owns. */
  refreshHistory(): void;
  /** Pass `expectChange` after a transfer this app just caused: the read is
   * re-issued on a bounded schedule until the figure actually moves, because a
   * replica can answer a fresh transfer with the balance from before it. */
  refreshBalance(options?: { expectChange?: boolean }): void;

  overlay: Overlay | null;
  pushOverlay(overlay: Overlay): void;
  /** Swaps the top of the stack. Used where going "back" to what you came from
   * makes no sense — a receipt must not return you to the pay screen that just
   * succeeded, and it would return you to a blank amount pad if it did. */
  replaceOverlay(overlay: Overlay): void;
  popOverlay(): void;
  closeOverlays(): void;
  /**
   * A receipt the URL names that has no row behind it yet.
   *
   * Every other overlay carries an id the URL can hold whole; a receipt carries
   * an `ActivityRow`, so `?receipt=<key>` on a cold load names a row this app
   * has not fetched. That is THREE answers, never two:
   *
   * - `loading` — the history is still being read. Saying "not found" here
   *   would be the same collapse `settlements === null` versus `[]` exists to
   *   prevent, and it would say it for the second before the row lands.
   * - `missing` — the history is in and the key is not in it. Reported, not
   *   swallowed: closing the overlay as if nothing had been asked for would
   *   leave a payer who followed a receipt link staring at a wallet screen
   *   with no idea their link did anything.
   * - resolved — this goes null and the receipt is a normal overlay on the
   *   stack, which is why it is not an `Overlay` kind of its own.
   *
   * `missing` is not a claim that the payment never happened, and the screen
   * must not word it as one: the history is paged, and a different signer has a
   * different history entirely.
   */
  pendingReceipt: PendingReceiptState | null;
  /**
   * A link named an overlay this app refused to open.
   *
   * Carried on the store rather than toasted where it is detected, because the
   * provider is mounted OUTSIDE ToastProvider — the toast stack is positioned
   * against the phone frame, so it has to live inside it. A child of that
   * provider reads this and reports it.
   *
   * Deliberately a bare flag and not a reason. Naming what was wrong needs the
   * parser to carry a rejection out of itself, and one honest sentence is worth
   * more today than a precise one later.
   */
  linkRefused: boolean;
  clearLinkRefused(): void;
}

const PayerContext = createContext<PayerStore | null>(null);

export function usePayer(): PayerStore {
  const store = useContext(PayerContext);
  if (!store) throw new Error("usePayer must be used inside <PayerProvider>");
  return store;
}

/** Newest page only. The design has no "load older" control, and 100 rows is
 * well past what a demo wallet accumulates — paging is an easy addition later,
 * every row already carries the cursor it would need. */
const HISTORY_LIMIT = 100;

/** How often the history is re-read in the background. */
const HISTORY_POLL_MS = 20_000;
/**
 * How often the agent list is re-read WHILE IT IS THE SCREEN ON SCREEN.
 *
 * `spentToday` is the one figure here that moves without this app doing
 * anything — the payer's own agent pays while they watch it — and 20s is far
 * too slow to read as that happening. Four seconds puts the bar inside the same
 * beat as the payment.
 *
 * The cost is FOUR RPC calls, not the two an earlier version of this comment
 * claimed. `candidates()` short-circuits to the factory's `walletsOf` view (one
 * `eth_call`, never behind, and never the swept table — the signer lookup is
 * what leans on that, and the payer app never asks for it), and the wallet
 * getters do collapse into one multicall. But `readAgents` fires that multicall
 * alongside one uncached `rateOf` per payable token, and the backend's transport
 * does not batch, so USDC and EURC are two more requests. Roughly 60 RPC calls a
 * minute per open agents screen.
 *
 * Half of that is the two `rateOf` reads, re-fetching an OWNER-SET fixed rate
 * that only changes on an owner transaction — so caching them is where to look
 * first if this ever needs defending. It is affordable on the demo laptop, which
 * is where the live tick matters; on a shared egress IP it is the figure to
 * weigh, because a rate limit belongs to the IP and not to the endpoint.
 */
export const AGENT_LIVE_POLL_MS = 4_000;

/** Bounded, and sized like the pay flow's own post-funding wait: a transfer
 * that has not surfaced after this long is reported as unconfirmed rather than
 * polled forever — see `balanceWatch`, which is what carries that answer to a
 * screen. */
const BALANCE_POLL_ATTEMPTS = 8;
const BALANCE_POLL_MS = 1_500;

/** Namespaced like the other payer preferences so one origin can hold several. */
/** New key on purpose: the preference used to choose a display symbol and now
 * chooses the token a payer signs, so a value stored under the old meaning must
 * not be silently reinterpreted as a payment instruction. */
const PAY_CURRENCY_KEY = "gantry.payCurrency";
/** Dead since `PriceReference` was deleted, and cleared at boot — see the
 * `removeItem` below for why a dead key next to a live one is worth deleting
 * rather than ignoring. */
const LEGACY_DISPLAY_CURRENCY_KEY = "gantry.displayCurrency";

export type BalanceWatch = "idle" | "watching" | "unconfirmed";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `pathname` + an overlay's query, merged into what is on screen now.
 *
 * Built from `window.location.search` rather than from the last URL this
 * provider wrote, which is the same rule the merchant directory follows: a
 * param nobody here owns — a `utm_*`, something a QR generator appended —
 * survives an overlay opening and closing instead of being deleted by the first
 * one to write. Every param the serializer CAN write is cleared first, so a
 * `pay` left over from the previous overlay cannot sit beside the `receipt`
 * that replaced it and make one URL name two overlays.
 */
function overlayUrl(pathname: string, serial: string): string {
  const next = new URLSearchParams(window.location.search);
  for (const key of OVERLAY_PARAMS) next.delete(key);
  for (const [key, value] of new URLSearchParams(serial)) next.set(key, value);
  const search = next.toString();
  return search === "" ? pathname : `${pathname}?${search}`;
}

export function PayerProvider({
  children,
  entry,
}: {
  children: ReactNode;
  /**
   * Set only by the two ENTRY routes, `/pay/:handle` and `/m/:handle`, where the
   * pathname is itself the encoding of the bottom overlay — the route IS the
   * payment, or IS the shop. Two things follow from that and both are why this
   * is one prop rather than two:
   *
   * - `overlay` is the FLOOR of the stack, and it contributes no query, because
   *   the pathname already says it. That keeps `/pay/x?sgd=1.50` — a submission
   *   artifact and the backend's dual-door redirect target — byte-identical to
   *   what it is today rather than rewritten to `?pay=x&sgd=1.50`.
   * - `exit` is where an emptied stack goes. On these routes there is nothing
   *   underneath: popping the floor used to leave the payer on the wallet
   *   screen with the URL still naming a half-finished payment, so a refresh
   *   dropped them back into it. A floor with nowhere to exit to IS that bug,
   *   so the two arrive together and cannot be supplied apart.
   *
   * The provider therefore never checks a pathname to work out where it is.
   */
  entry?: { overlay: Overlay; exit: () => void };
}) {
  const identity = usePayerIdentity();
  const publicClient = usePublicClient();
  const address = identity.address;
  const pathname = usePathname();

  const [agentsRead, setAgentsRead] = useState<AgentSummary[] | null>(null);
  /** Writes this browser watched mine, held until a read agrees. Declared
   * beside the read it reconciles, because `agents` below is derived from
   * both and neither means anything on its own. */
  const [expectations, setExpectations] = useState<Record<string, AgentExpectation>>({});

  /**
   * The agent list RECONCILED with what this browser watched mine.
   *
   * Overlaid here, once, rather than at each screen — because "remember to apply
   * the pending write before you render this" is a rule every new consumer has
   * to be told, and three of them were caught not knowing it: the list rendered
   * a replaced name as fact, then froze on `Saving…`, and the denial receipt's
   * remedy card told a payer their agent was "still refused today" seconds after
   * they had widened the very rule that refused it. Same stale array behind all
   * three. A screen cannot forget a reconciliation it never has to do.
   *
   * A read that already agrees is passed through untouched, so the object
   * identity of `agents` only changes when the underlying data does.
   */
  const agents = useMemo(() => {
    if (agentsRead === null) return null;
    if (Object.keys(expectations).length === 0) return agentsRead;
    const now = Date.now();
    return agentsRead.map((agent) => {
      const pending = expectations[agent.wallet.toLowerCase()];
      // Expiry BEFORE the fingerprint: past the TTL the read wins whether it
      // agrees or not. `agentsRead` changing is what re-runs this, which is also
      // the only moment an overlay could newly be wrong — so an expired entry is
      // always dropped before its values are used, without a timer.
      if (!pending || now - pending.at >= EXPECTATION_TTL_MS) return agent;
      if (policyFingerprint(agent) === pending.fingerprint) return agent;
      return { ...agent, ...pending.proven };
    });
  }, [agentsRead, expectations]);

  /**
   * Is this row the receipt's answer rather than the backend's?
   *
   * Only for SAYING so. Nothing on screen should behave differently — the values
   * are true either way — but a payer comparing this against Basescan in the next
   * few seconds may still see the older ones, so the provenance is stated.
   */
  const agentAhead = useCallback(
    (wallet: Address) => {
      const key = wallet.toLowerCase();
      const pending = expectations[key];
      if (!pending || agentsRead === null) return false;
      // The same expiry the memo applies, or the badge outlives the overlay it
      // names — "Just changed · reading it back" over a plain read.
      if (Date.now() - pending.at >= EXPECTATION_TTL_MS) return false;
      const read = agentsRead.find((agent) => agent.wallet.toLowerCase() === key);
      return read !== undefined && policyFingerprint(read) !== pending.fingerprint;
    },
    [agentsRead, expectations],
  );
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentsUnreadable, setAgentsUnreadable] = useState<Address[]>([]);
  const [settlements, setSettlements] = useState<SettlementEvent[] | null>(null);
  const [settlementsError, setSettlementsError] = useState<string | null>(null);
  const [denials, setDenials] = useState<DenialEvent[]>([]);
  const [denialsError, setDenialsError] = useState<string | null>(null);
  /**
   * Have the refusal pages been ASKED for and answered?
   *
   * `denials` starts `[]` and is `[]` again for a payer with no agents, so the
   * array cannot tell "none exist" from "not fetched" — the same collapse
   * `settlements === null` avoids by being nullable. Nothing needed the
   * distinction until a receipt could be named by a URL: a `denial:` key looked
   * up one tick too early would render "that payment isn't in this wallet's
   * history" over a refusal that was still in flight.
   */
  const [denialsReady, setDenialsReady] = useState(false);
  /**
   * The two chain reads, each STAMPED with the token it answered for.
   *
   * Not `bigint | null` beside a separate "is it stale" flag, because the
   * dangerous state is the one a flag lets you forget to set. Both reads follow
   * `sendToken`, and both used to be written only on SUCCESS — so switching to
   * euros left USDC's rate and USDC's balance on screen, relabelled EURC, for a
   * whole round-trip. That is not a slow update: `1 EURC = 1.3421 XSGD` is a
   * false exchange rate, and `rate` is what EVERY S$ figure in this app converts
   * at, so the wrong number was not confined to the screen that showed it. About
   * 12.5% adrift at 1.3421 against 1.5100.
   *
   * Stamped rather than cleared by an effect: clearing depends on effect
   * ORDERING and on the next person remembering the rule, while a stamp makes
   * the stale value unreadable by construction. The exposed `rate` and `balance`
   * below are `null` the instant the currency changes, which is exactly what
   * "we do not know yet" should look like. Same move as making an unpayable
   * currency unrepresentable rather than filtering it out.
   *
   * The ERRORS are stamped too. A failure reading USDC says nothing about EURC,
   * and leaving it up would put "balance unavailable" over a currency nobody
   * has tried to read.
   */
  const [balanceRead, setBalanceRead] = useState<{ token: TokenId; value: bigint } | null>(null);
  const [balanceErrorRead, setBalanceErrorRead] = useState<{
    token: TokenId;
    message: string;
  } | null>(null);
  const [rateRead, setRateRead] = useState<{ token: TokenId; value: bigint } | null>(null);
  const [rateErrorRead, setRateErrorRead] = useState<{ token: TokenId; message: string } | null>(
    null,
  );
  /**
   * Which currency the payer PAYS IN — no longer merely what they read.
   *
   * It now decides the token on the authorization they sign, the balance the
   * wallet reads and the asset the intent is quoted in, so it is the closest
   * thing this app has to an account setting. Lives here rather than in each
   * screen because the settings sheet and the pay overlay are mounted at the
   * same time — two useState copies would let a payer change it in one and
   * watch the other sign in the old token, which is the same divergence the
   * signer preference reloads the page to avoid.
   *
   * Constrained to PAYABLE currencies, which is what makes the rest of the app
   * able to assume `sendToken` exists. Starts at USD on both sides of hydration
   * and the stored value is read in an effect, because the server cannot know
   * it: a payer who chose euros sees one frame of dollars.
   */
  const [payCurrencyCode, setPayCurrencyCode] = useState<DisplayCurrencyCode>("USD");
  /**
   * Has the stored preference been read yet?
   *
   * The default above is a GUESS until the effect below runs, and the two chain
   * reads in this provider both follow `sendToken` — so without this gate a
   * euro payer's first frame issues a USDC balance read and a USDC rate read,
   * then re-issues both. That is a wasted round-trip on a venue hotspot and,
   * worse, a window in which every S$ figure in the app is converted at the
   * wrong token's rate. The signer preference has the same rule and for the
   * same reason: defaulting before the read is a claim, not a default.
   */
  const [payCurrencyReady, setPayCurrencyReady] = useState(false);
  const [balanceWatch, setBalanceWatch] = useState<BalanceWatch>("idle");
  const [merchants, setMerchants] = useState<Record<string, MerchantResponse | null>>({});
  const [merchantErrors, setMerchantErrors] = useState<Record<string, string>>({});
  const [clockOffset, setClockOffset] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [historyNonce, setHistoryNonce] = useState(0);
  const [balanceNonce, setBalanceNonce] = useState(0);
  /**
   * Re-reads the agent list ALONE, which `nonce` cannot do.
   *
   * `nonce` is the everything trigger — the enumeration, the balance and the
   * rate all sit behind it — so driving a 4s live tick from it would re-read a
   * payer's ERC-20 balance and the swap rate every four seconds to watch one
   * counter move. Narrow trigger, same single effect: `refresh()` keeps meaning
   * "re-read all of it", and this means "just the agents".
   */
  const [agentsNonce, setAgentsNonce] = useState(0);
  /**
   * An agent read is outstanding, so the live tick must not fire.
   *
   * Bumping the nonce RE-RUNS the effect, and its cleanup sets the previous
   * run's `cancelled` — so a tick arriving before a read completes does not
   * merely duplicate it, it DISCARDS it. `api.agents` carries a 20s timeout
   * against a 4s interval, so on any backend slower than the tick every request
   * was cancelled by its successor and neither `setAgentsRead` nor
   * `setAgentsError` ever ran: permanent skeletons, and the error card holding
   * the "don't create a second wallet" warning unreachable, which is precisely
   * the state that warning exists for. Reachable on a Render cold start, on a
   * venue hotspot, or after an RPC failover to the rate-limited public node.
   *
   * Skipping while one is in flight also caps concurrency at one, where the
   * free-running interval otherwise left ~5 requests outstanding per tab, each
   * costing four RPC calls, and starved the settlements and denials sharing the
   * browser's six connections to that origin.
   */
  const agentsInFlight = useRef(false);
  /** What triggered the last agent read, so a failure knows whether a person is
   * waiting on it. See `background` in the effect below. */
  const agentsTrigger = useRef<{ address: Address | undefined; nonce: number }>({
    address: undefined,
    nonce: -1,
  });

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(PAY_CURRENCY_KEY);
      // Validated AND checked for payability, not merely cast. The key is
      // user-writable, and a value that is a real currency but not a payable one
      // — a stale "SGD" or "INR" from when this preference only chose a display
      // symbol — would resolve to a token nothing can settle and strand the
      // payer on a signing screen. Anything unusable falls back to the default.
      if (stored !== null && isDisplayCurrencyCode(stored) && DISPLAY_CURRENCIES[stored].settleable) {
        setPayCurrencyCode(stored);
      }
    } catch (err) {
      // Touching `window.localStorage` at all throws SecurityError when site
      // data is blocked. Unguarded that propagates out of the provider and takes
      // down the whole payer app over a currency symbol.
      console.warn("gantry: pay currency preference could not be read", err);
    } finally {
      // In a `finally`, so a blocked-storage SecurityError releases the reads
      // too. Failing to read the preference means falling back to the default,
      // which is an answer; leaving the app permanently waiting is not.
      setPayCurrencyReady(true);
    }
    try {
      // The key this one REPLACED, removed rather than left lying in real
      // browsers. `gantry.displayCurrency` chose a display symbol; this chooses
      // a token, and the rename exists precisely so a value stored under the old
      // meaning can never be read as a payment instruction. Nothing has read it
      // since `PriceReference` was deleted — but it sits one word away from a
      // live key and holds values like `inr`, which is not payable at all, so
      // the next person to find it has every reason to think it is config.
      window.localStorage.removeItem(LEGACY_DISPLAY_CURRENCY_KEY);
    } catch (err) {
      // Logged, not assumed. The comment here used to assert "blocked storage,
      // nothing to clean up anyway" — true of the case where `getItem` above has
      // already logged, and unfalsifiable for every other. A storage that READS
      // but refuses writes (Safari private browsing has behaved this way, as do
      // some enterprise policies) fails only here, and the stale key this exists
      // to delete then survives with no trace anywhere.
      console.warn("gantry: legacy display-currency key could not be cleared", err);
    }
  }, []);

  const setPayCurrency = useCallback((code: DisplayCurrencyCode) => {
    // Refuses silently rather than throwing: the caller is a button, and the
    // locked options are already unclickable. This is the second gate, so a
    // future screen cannot make an unsendable currency current by wiring a
    // handler to it.
    if (!DISPLAY_CURRENCIES[code].settleable) return;
    setPayCurrencyCode(code);
    try {
      window.localStorage.setItem(PAY_CURRENCY_KEY, code);
    } catch (err) {
      // The selection has already applied, so this only means it will not
      // survive a reload. Better a preference that forgets than a crash.
      console.warn("gantry: pay currency preference could not be saved", err);
    }
  }, []);

  const payCurrency = DISPLAY_CURRENCIES[payCurrencyCode];
  /** The token every read and every signature below follows. */
  const sendToken = settlementSendToken(payCurrency);
  const sendTokenAddress = tokenAddress(BASE_SEPOLIA_ADDRESSES, sendToken);

  /* Only a read of the CURRENT token is an answer about the current token. A
     stamp from the previous one is not "nearly right" — see the note on the
     state above — so it reads as null and the screens render their own
     not-yet-known state, which they already have for the first load. */
  const balance = balanceRead?.token === sendToken ? balanceRead.value : null;
  const balanceError = balanceErrorRead?.token === sendToken ? balanceErrorRead.message : null;
  const rate = rateRead?.token === sendToken ? rateRead.value : null;
  const rateError = rateErrorRead?.token === sendToken ? rateErrorRead.message : null;

  /* ── Overlays, and the URL ──────────────────────────────────────────────
     Overlays are a stack so "receipt → about this shop → back" lands on the
     receipt rather than dumping the payer onto a tab they never chose.

     THE URL CARRIES THE TOP OVERLAY ONLY; the stack keeps the depth. So an
     in-app "receipt → about this shop" is two deep in memory while the URL says
     the shop, and a refresh there restores a valid ONE-deep stack showing the
     shop. That is a deliberate trade and not an oversight: encoding a whole
     stack in a query string produces a URL nobody can read or hand-edit — the
     opposite of the point — and the depth here is never more than two, so what
     is lost is one Back press on a link somebody pasted.

     The sync is the History API, never `router.push`/`router.replace`, for the
     reason `directory-client.tsx` records at length: which overlay is open is a
     decision this client has already made over state it already holds, and a
     router navigation per change queues RSC round-trips until the address bar
     is several steps stale — which is worse than no sync at all, because the
     stale URL is the one that gets copied. `pushState` is synchronous and
     cannot fall behind. Opening PUSHES and closing REPLACES, so Back is a way
     OUT of an overlay rather than a way back into it. */
  const [stack, setStack] = useState<Overlay[]>(() =>
    entry ? [entry.overlay] : [],
  );
  /** A receipt the URL names whose row has not been found yet — see the store
   * field of the same name for why this is not an `Overlay` kind. */
  const [pendingReceiptKey, setPendingReceiptKey] = useState<string | null>(null);

  /**
   * The entry route's floor overlay and its exit, captured ONCE.
   *
   * The floor is compared by IDENTITY below to decide whether the top of the
   * stack is the thing the pathname already says. The prop it comes from is an
   * object literal built by the page above, so it is rebuilt whenever that page
   * re-renders — capturing it here is what keeps the comparison meaning "the
   * overlay this route opened with" rather than "an overlay that happens to
   * look like it".
   */
  const floorRef = useRef<Overlay | null>(entry?.overlay ?? null);
  const exitRef = useRef<(() => void) | undefined>(entry?.exit);
  useEffect(() => {
    exitRef.current = entry?.exit;
  });

  /**
   * The overlay query the URL and the stack are known to AGREE on.
   *
   * This one ref is what stops the two halves driving each other forever: the
   * effect that writes the URL from the stack returns early when the stack
   * already serializes to this, and the `popstate` handler that writes the
   * stack from the URL sets it to what the URL says before touching state. So
   * whichever side moves first, the other sees agreement and does nothing.
   *
   * It holds the SERIALIZED form rather than the raw search string on purpose.
   * The two are not the same: a URL may carry params this module does not own,
   * and `?pay=x&sgd=junk` resolves to an overlay that serializes back as
   * `pay=x`. Comparing raw strings would see a difference that is not one and
   * rewrite the payer's URL under them.
   */
  const lastSyncedRef = useRef("");
  /** How many overlays were on screen when the URL last agreed — the input to
   * push-versus-replace. A pending receipt counts as one: it occupies the
   * screen, and it becomes a real overlay without the URL changing. */
  const lastDepthRef = useRef(entry ? 1 : 0);
  /**
   * The URL has been read AND the stack it produced has been applied.
   *
   * State rather than a ref, and that distinction was a real bug rather than a
   * style choice. Effects all run on the same commit, so a ref flipped by the
   * seed is already true when the writer below runs — but the writer's `stack`
   * is still the one from the render that just painted, i.e. the empty
   * pre-seed one. On a cold `/app?shop=ah-hock-chicken-rice` that read as "no
   * overlay", replaced the URL down to `/app` (deleting the query it had just
   * been asked to honour) and then pushed the shop back on a render later — a
   * spurious history entry and a moment where the link had been thrown away.
   * As state it gates the writer until the commit that CARRIES the seeded
   * stack, which is the thing the writer actually needs.
   */
  const [seeded, setSeeded] = useState(false);
  const [linkRefused, setLinkRefused] = useState(false);
  const clearLinkRefused = useCallback(() => setLinkRefused(false), []);
  /** The newest rows, for the one lookup that cannot wait for a render: Back
   * onto a `?receipt=` the app already has in hand should open it, not flash a
   * loading screen at a payer who has been looking at that row all along. */
  const rowsRef = useRef<ActivityRow[]>([]);

  /**
   * What the URL should say, given what is on screen.
   *
   * The floor overlay of an entry route serializes to NOTHING, because the
   * pathname already says it: `/pay/ah-hock-chicken-rice?sgd=1.50` is a printed
   * link and a backend redirect target, and rewriting it to
   * `?pay=ah-hock-chicken-rice&sgd=1.50` would restate the route in its own
   * query for no reader's benefit.
   */
  const serialize = useCallback((top: Overlay | null, pendingKey: string | null): string => {
    if (pendingKey !== null) return receiptQuery(pendingKey).toString();
    if (top === null || top === floorRef.current) return "";
    return overlayToQuery(top).toString();
  }, []);

  /**
   * Reads the URL and makes the stack match it.
   *
   * Used for the mount seed and for Back/Forward, which is the same operation:
   * the URL is the authority and the stack is what has to move. Depth is set to
   * one because that is what the URL can carry — see the note on the stack.
   */
  const applyUrl = useCallback(
    (search: string) => {
      const asked = overlayFromQuery(new URLSearchParams(search));
      const floor = floorRef.current;

      if (asked === null) {
        // No overlay in the query. On an entry route that is the FLOOR — the
        // pathname's own overlay — which is what makes Back out of `/m/x?pay=x`
        // land on the shop page rather than leaving the site.
        lastSyncedRef.current = "";
        lastDepthRef.current = floor ? 1 : 0;
        setPendingReceiptKey(null);
        setStack((prev) =>
          prev.length === (floor ? 1 : 0) && (floor === null || prev[0] === floor)
            ? prev
            : floor
              ? [floor]
              : [],
        );
        return;
      }

      if (asked.kind === "receipt") {
        lastSyncedRef.current = receiptQuery(asked.key).toString();
        lastDepthRef.current = 1;
        // A resolved row may carry a DIFFERENT key than the URL asked for — see
        // `findActivityRow`. `lastSyncedRef` above holds what the URL says, so
        // the write-back sees a mismatch and replaces it with the canonical
        // key, which is the correction and not a loop: one write, and the two
        // agree afterwards.
        const row = findActivityRow(rowsRef.current, asked.key);
        setPendingReceiptKey(row ? null : asked.key);
        setStack(row ? [{ kind: "receipt", row }] : []);
        return;
      }

      lastSyncedRef.current = overlayToQuery(asked.overlay).toString();
      lastDepthRef.current = 1;
      setPendingReceiptKey(null);
      setStack([asked.overlay]);
    },
    [],
  );

  /* The seed. Batched with `applyUrl`'s own writes, so the commit that turns
     `seeded` on is the same commit that carries the stack the URL asked for —
     see the note on `seeded` for what happens when those two come apart. */
  useEffect(() => {
    const search = window.location.search;
    /* The link named an overlay and none opened — say so.
       Refusing to render junk off a URL is the half that matters and it works,
       but the payer was told nothing: they land on their wallet tab, unable to
       tell a link that was refused from one that only ever opened the app. The
       realistic case is a merchant's charge link mangled by a chat client or
       retyped wrong, where a customer is left with no idea a payment was being
       asked for. Read BEFORE `applyUrl`, which rewrites nothing on this path but
       is free to in future. */
    const params = new URLSearchParams(search);
    if (namesAnOverlay(params) && overlayFromQuery(params) === null) setLinkRefused(true);
    applyUrl(search);
    setSeeded(true);
  }, [applyUrl]);

  /** A history navigation is in flight, so the pathname effect below must not
   * treat the pathname landing as a fresh navigation and clear what this just
   * restored. See the note there. */
  const poppedRef = useRef(false);
  useEffect(() => {
    const onPop = () => {
      poppedRef.current = true;
      applyUrl(window.location.search);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [applyUrl]);

  /**
   * A real navigation closes the overlays, and the PROVIDER has to be what does
   * it rather than the tab that was tapped.
   *
   * The tab bar used to close them in its own `onClick`, and once the stack was
   * wired to the URL that raced the navigation the same click started: Next
   * patches `history.replaceState`, so the write-back below — firing on the
   * emptied stack with the OLD pathname, because the router had not committed
   * yet — superseded the in-flight navigation. Measured: the overlay closed,
   * the URL stayed on `/app/agents`, and the tab never changed. Closing here
   * instead means the write-back only ever runs once the router has landed,
   * where the two already agree.
   *
   * The first run is skipped. A mount is not a navigation, and closing there
   * would throw away the overlay the URL had just asked for.
   */
  const lastPathRef = useRef(pathname);
  useEffect(() => {
    if (lastPathRef.current === pathname) return;
    lastPathRef.current = pathname;
    /* A pathname change from BACK/FORWARD is not a fresh navigation, and this
       effect could not tell the two apart — they arrive here identically.
       Back out of `/app/activity?receipt=…` → `/app/agents` ran the popstate
       listener (which restored the receipt) and then this effect (which cleared
       it), and the write-back then saw an empty stack against a non-empty
       `lastSyncedRef` and REPLACED the `?receipt=` away — so Back landed on a
       bare tab and DESTROYED the link rather than merely declining to open it.
       Same for `?agent=`, `?pay=`, `?shop=`, and for Forward.

       The flag is set by the popstate listener, which has already applied the
       URL by the time this runs. Re-reading `window.location.search` here was
       tried instead and is WRONG: this effect runs before Next commits the new
       location for a `<Link>` push, so it read the OUTGOING query, re-seeded the
       overlay, and the write-back pushed a SECOND history entry — measured, a
       tab tap took `history.length` from 39 to 41 and Back then landed back on
       the tab it started from. The flag needs no such assumption. */
    if (poppedRef.current) {
      poppedRef.current = false;
      return;
    }
    setPendingReceiptKey(null);
    setStack((prev) => (prev.length === 0 ? prev : []));
  }, [pathname]);

  /* The stack, written back to the URL. */
  useEffect(() => {
    if (!seeded) return;
    const serial = serialize(stack.length > 0 ? stack[stack.length - 1]! : null, pendingReceiptKey);
    const depth = pendingReceiptKey !== null ? 1 : stack.length;
    // The guard. Nothing below runs when the URL already says this, which is
    // what makes `popstate` → `setStack` → this effect terminate instead of
    // bouncing. The depth is still recorded: a pending receipt becoming a real
    // one changes the stack without changing the URL, and forgetting that would
    // make the payer's next tap look like a jump of two.
    if (serial === lastSyncedRef.current) {
      lastDepthRef.current = depth;
      return;
    }
    const grew = depth > lastDepthRef.current;
    const url = overlayUrl(pathname, serial);
    /* The bookkeeping is committed only AFTER the write lands.
       `pushState` throws — Safari rate-limits it above ~100 calls in 30s — and
       this runs in an effect, so an unguarded throw escalates to the root error
       boundary and destroys the provider, including an in-flight pay flow
       holding a signed authorization. The precedent this pattern copies
       (`directory-client.tsx`) makes the same calls from EVENT HANDLERS, where a
       throw logs and moves on; moving it into an effect changed the blast
       radius. Recording agreement before the call would be the worse half of the
       trade: the guard above would then early-return forever, permanently
       convinced the URL matches a stack it does not. Left untouched, the next
       commit retries. */
    try {
      if (grew) window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
      lastSyncedRef.current = serial;
      lastDepthRef.current = depth;
    } catch (err) {
      console.warn("gantry: overlay URL sync failed; the address bar is stale", err);
    }
  }, [seeded, stack, pendingReceiptKey, pathname, serialize]);

  /**
   * An emptied stack on an entry route has to LEAVE the route.
   *
   * This is the reported bug: closing the overlay on `/pay/ah-hock-chicken-rice`
   * popped the stack and left the payer on the wallet screen while the URL still
   * named a payment, so a refresh dropped them back into a half-finished one. A
   * real Next navigation rather than `history.replaceState`, because unlike
   * every other transition here this genuinely IS leaving the route; the
   * provider remounting on the way out costs nothing, since the stack it would
   * carry is the one that just emptied.
   */
  const exitedRef = useRef(false);
  useEffect(() => {
    // `seeded` for the same reason the writer gates on it: before the seed
    // lands, an empty stack is this component's default rather than an answer
    // about the URL — and acting on it would navigate away from a link that
    // had not been read yet.
    if (!seeded || exitedRef.current) return;
    // A pending receipt is on screen with an empty stack, and closing it is the
    // payer's decision to make rather than something to pre-empt.
    if (stack.length > 0 || pendingReceiptKey !== null) return;
    const exit = exitRef.current;
    if (!exit) return;
    exitedRef.current = true;
    exit();
  }, [seeded, stack, pendingReceiptKey]);

  /* `nonce` and `balanceNonce` are refetch triggers, not data: bumping one is
     what re-runs the effects below after a payment or a policy write. They look
     like unused dependencies and are not — removing them from a dep array
     silently freezes that fetch for the life of the session. */
  const refresh = useCallback(() => {
    setNonce((n) => n + 1);
    setHistoryNonce((n) => n + 1);
  }, []);
  const refreshHistory = useCallback(() => setHistoryNonce((n) => n + 1), []);

  /* A balance read issued the instant a transfer returns is a read of the state
     BEFORE it: the transfer is mined, but the replica answering can be behind,
     and one shot at it leaves the old number on screen until something else
     happens to refetch. That is what made "Top up" look like it did nothing —
     the grant landed and the figure did not move.

     So `expectChange` re-reads on a bounded schedule and stops the moment the
     value actually differs. Same discipline as the pay flow, which polls after
     funding a burner before it will sign.

     Its two exits are NOT the same answer and must not be the same code path:
     the figure moved, or the poll ran out with it still sitting where it was.
     `balanceWatch` is what carries that distinction to a screen — a bare return
     on both would let "we gave up" render exactly like "it arrived". */
  const balanceRef = useRef<bigint | null>(null);
  const balanceTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  /* Every poll carries the token it started with. A second top-up supersedes the
     first, and without this the older poll would keep bumping the nonce and
     could declare `unconfirmed` against a baseline the newer one has moved past. */
  const pollToken = useRef(0);
  useEffect(() => {
    const pending = balanceTimers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  const refreshBalance = useCallback((options?: { expectChange?: boolean }) => {
    setBalanceNonce((n) => n + 1);
    if (!options?.expectChange) return;
    const before = balanceRef.current;
    const token = (pollToken.current += 1);
    setBalanceWatch("watching");
    let attempts = 0;
    // Timers are removed from the set as they fire, not only on unmount — the
    // set is a cleanup registry, and one that only ever grows is a leak that
    // outlives every poll it was meant to cancel. The toast primitive does the
    // same thing for the same reason.
    const schedule = () => {
      const timer = setTimeout(() => {
        balanceTimers.current.delete(timer);
        poll();
      }, BALANCE_POLL_MS);
      balanceTimers.current.add(timer);
    };
    const poll = () => {
      if (token !== pollToken.current) return; // a newer poll owns the answer
      if (balanceRef.current !== before) {
        setBalanceWatch("idle");
        return;
      }
      if (attempts >= BALANCE_POLL_ATTEMPTS) {
        // The transfer was reported mined and the figure never moved. Say so.
        console.warn("gantry: balance did not change after a transfer this app caused");
        setBalanceWatch("unconfirmed");
        return;
      }
      attempts += 1;
      setBalanceNonce((n) => n + 1);
      schedule();
    };
    schedule();
  }, []);

  /* The feed can change without this app doing anything — the payer's own agent
     pays while they watch. There is no SSE here on purpose: the live stream is
     the merchant's screen, and a payer app holding a long-lived connection open
     on a phone for one row a minute is the wrong trade. A poll covers it, and it
     stops while the tab is hidden so a pocketed phone is not calling the backend
     every twenty seconds. */
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") setHistoryNonce((n) => n + 1);
    };
    const timer = setInterval(tick, HISTORY_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  /**
   * The same idea one screen narrower: keep the CAP METERS live.
   *
   * The agent enumeration used to be excluded from the tick above on the
   * grounds that it "walks a block range". That is true of the SIGNER lookup
   * and false of the one this app makes: `?owner=` is answered from the
   * factory's `walletsOf` view, which is a getter and cannot be stale. See
   * `AGENT_LIVE_POLL_MS` for what it actually costs. The figure it carries —
   * `spentToday` — is the only one on the agents screen that moves on its own,
   * and a bar that only ever fills on a manual refresh states a live allowance
   * as a static one.
   *
   * A SECOND timer rather than a faster shared one, deliberately. The two drive
   * disjoint state (`historyNonce` → settlements and denials, `agentsNonce` →
   * the enumeration), so there is no shared value for two schedules to race
   * over — the hazard `agent-detail`'s single owner of `fresh` exists to avoid.
   * Folding them together would instead make a working 20s path run five times
   * faster as a side effect of standing on a different tab.
   *
   * Armed only while the LIST is what is being looked at. An open overlay is
   * full-screen on this surface, and the agent detail reads its own wallet on
   * its own schedule, so refreshing the list behind it would be RPC nobody can
   * see.
   */
  const watchingAgentList =
    pathname === "/app/agents" && stack.length === 0 && pendingReceiptKey === null;
  useEffect(() => {
    if (!watchingAgentList) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      // See `agentsInFlight`. Ticking over an outstanding read cancels it, so on
      // a slow backend the list could never resolve at all. This makes the real
      // cadence `max(4s, round trip)`, which is the honest bound anyway.
      if (agentsInFlight.current) return;
      setAgentsNonce((n) => n + 1);
    };
    const timer = setInterval(tick, AGENT_LIVE_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [watchingAgentList]);

  /* Every mutator clears the pending receipt. It is a claim about what the URL
     asked for, and the moment the payer moves anywhere themselves that claim is
     answered — leaving it set would put a "looking for this receipt" screen back
     over whatever they just opened. `popOverlay` clearing it is also how the
     pending screen's own back button works, since its stack is empty. */
  const pushOverlay = useCallback((overlay: Overlay) => {
    setPendingReceiptKey(null);
    setStack((s) => [...s, overlay]);
  }, []);
  const replaceOverlay = useCallback((overlay: Overlay) => {
    setPendingReceiptKey(null);
    setStack((s) => [...s.slice(0, -1), overlay]);
  }, []);
  const popOverlay = useCallback(() => {
    setPendingReceiptKey(null);
    setStack((s) => s.slice(0, -1));
  }, []);
  /* Known limit, inherited from the directory's rule and left in step with it
     deliberately: closing REPLACES one history entry, so emptying a two-deep
     stack in one call leaves the entry for the overlay underneath behind. Back
     from a closed pay flow can therefore re-open the shop page it was reached
     from, and a second press leaves. The alternative is `history.go(-n)`, which
     walks off the site entirely when those entries were never ours — a deep
     link into `/app?pay=x` has none. A dead Back press beats leaving the app. */
  const closeOverlays = useCallback(() => {
    setPendingReceiptKey(null);
    setStack([]);
  }, []);

  /* ── Agent wallets ──────────────────────────────────────────────────────
     Read from the factory's `walletsOf` view, so this is current the instant a
     wallet exists rather than lagging an index. It is still a round trip and a
     hotspot still makes it slow, so screens must render a loading state off
     `agents === null` rather than flashing "no agents" at a payer who has three.

     `unreadable` is carried, never dropped. A wallet that holds code and did not
     answer is a failed READ, and folding it into an empty `agents` tells a payer
     who owns an agent that they own none — beside a Create button. */
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    /**
     * Was this run asked for by a PERSON, or by the live tick?
     *
     * The two want opposite failure handling and the effect cannot otherwise
     * tell them apart. A mount, an account change and `refresh()` all move
     * `address` or `nonce`; the tick moves neither, so a run where both match
     * the previous one is the tick's.
     */
    const background =
      agentsTrigger.current.address === address && agentsTrigger.current.nonce === nonce;
    agentsTrigger.current = { address, nonce };
    // Only a person's request may retract a standing error. Clearing it on
    // every tick made the error card strobe: visible for one round trip, blank
    // for the rest of the interval, which reads as a screen still loading.
    if (!background) setAgentsError(null);
    agentsInFlight.current = true;
    api
      .agents({ owner: address })
      .then((res) => {
        if (cancelled) return;
        setAgentsRead(res.agents);
        setAgentsUnreadable(res.unreadable ?? []);
        // A success retires a background failure nobody was shown, so the next
        // person-initiated read does not start life holding a stale message.
        setAgentsError(null);
      })
      .catch((err: unknown) => {
        // Logged BEFORE the cancelled guard. A superseded request is the one
        // shape of failure that reaches no screen at all, and a poll makes
        // supersession ordinary rather than exceptional.
        console.warn("gantry: agent enumeration failed", err);
        if (cancelled) return;
        /**
         * A BACKGROUND failure changes nothing on screen, deliberately.
         *
         * The alternative is what this used to do unconditionally, and as a 4s
         * poll it is worse than the staleness it would report: one blip
         * replaces a working list with "We couldn't list your agents… you'll
         * have two", the next tick puts the list back, and on a flapping
         * hotspot that alarming card strobes until the payer learns to ignore
         * the one warning standing in front of an irreversible duplicate
         * wallet. It also cascades — `agentsRead === null` empties
         * `payerFilter` and `agentWalletsKey` below, which narrows history to
         * the human address and clears every denial row, so a failed AGENT
         * read would silently delete the refusal record from Activity.
         *
         * Same trade the withdraw wait makes one file over: a figure that is a
         * moment old beats a figure that has vanished. The next tick retries.
         */
        if (background) return;
        // NOT `[]`. This state means "we do not know", and `[]` means "we asked
        // and there are none" — the distinction this very field documents. It
        // leaks past the agents screen: `payerFilter` below is built from this
        // list, and a PBM payment's on-chain payer is the WALLET, so an empty
        // list silently narrows the history query to the human address and drops
        // every agent payment out of Activity with nothing on screen saying so.
        setAgentsRead(null);
        // The whole enumeration failed, so there is no per-wallet verdict to
        // report; `agentsError` is the one that has to be on screen.
        setAgentsUnreadable([]);
        setAgentsError(messageOf(err));
      })
      .finally(() => {
        agentsInFlight.current = false;
      });
    return () => {
      cancelled = true;
    };
    // `agentsNonce` alongside `nonce`: the live tick re-reads this and only
    // this, so the enumeration keeps ONE owning effect rather than growing a
    // second fetcher writing `agentsRead` on an independent schedule.
  }, [address, nonce, agentsNonce]);

  /* ── History ────────────────────────────────────────────────────────────
     One request for the payer AND their agent wallets, because a PBM payment's
     on-chain payer is the wallet and a bridged x402 payment's is the relayer —
     filtering on the human alone hides exactly the rows the agents screen
     exists to explain. The filter widens once the wallet list lands, which is a
     second request only when the payer actually owns agents. */
  const payerFilter = useMemo(() => {
    if (!address) return null;
    return [address, ...(agents ?? []).map((agent) => agent.wallet)];
  }, [address, agents]);
  const payerFilterKey = payerFilter?.join(",").toLowerCase() ?? "";

  useEffect(() => {
    if (!payerFilterKey) return;
    let cancelled = false;
    setSettlementsError(null);
    api
      .settlements({ payer: payerFilterKey.split(","), limit: HISTORY_LIMIT })
      .then((res) => {
        if (!cancelled) setSettlements(res.rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSettlements([]);
        setSettlementsError(messageOf(err));
      });
    return () => {
      cancelled = true;
    };
  }, [payerFilterKey, historyNonce]);

  /* Refusals are stored per wallet, so this is one call per agent. A payer has
     a handful of agents at most; a combined filter would be a nicer API but not
     a different screen.

     A failure here does not blank a working history — the declined rows are
     additive — but it can never be silent either: a refused agent payment
     produces no settle transaction, so its record rides on the CANCEL — it
     happened. Dropping it on the floor is how the rejection beat would simply
     not appear on stage, with nothing on screen saying why. */
  const agentWalletsKey = (agents ?? []).map((agent) => agent.wallet).join(",");
  useEffect(() => {
    if (!agentWalletsKey) {
      setDenials([]);
      setDenialsError(null);
      return;
    }
    let cancelled = false;
    // Retracted for the duration of the fetch, so a wallet list that changed
    // (a new agent, a refresh) cannot leave a stale "we have looked" standing
    // over rows nobody has asked for yet.
    setDenialsReady(false);
    const wallets = agentWalletsKey.split(",") as Address[];
    void Promise.all(
      wallets.map((wallet) =>
        api
          .denials(wallet)
          .then((res) => ({ rows: res.rows, error: null as string | null }))
          .catch((err: unknown) => {
            console.warn(`gantry: denials lookup failed for ${wallet}`, err);
            return { rows: [] as DenialEvent[], error: messageOf(err) };
          }),
      ),
    ).then((pages) => {
      if (cancelled) return;
      setDenials(pages.flatMap((page) => page.rows));
      setDenialsError(pages.find((page) => page.error)?.error ?? null);
      // Set even when every page failed. "We asked and it did not work" is an
      // answer; the errors above are what say so, and a permanent "still
      // loading" would be the wrong one.
      setDenialsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [agentWalletsKey, historyNonce]);

  /* ── The payer's balance ────────────────────────────────────────────────
     Its own effect, because `balanceNonce` is what the poll above bumps — up to
     nine times for one top-up. The rate and the block used to share this effect
     and were therefore re-read on every one of those ticks, turning a single
     grant into three times the RPC calls it needs. Neither of them is what a
     transfer changed.

     A failed read is BOTH logged and surfaced: collapsed into "not yet", it
     leaves the wallet screen reading "reading balance…" for as long as the app
     stays open. */
  useEffect(() => {
    // `payCurrencyReady` too: until the stored preference has been read,
    // `sendTokenAddress` is the DEFAULT rather than the payer's choice, and
    // reading against it would answer in a token they do not pay in.
    if (!address || !publicClient || !payCurrencyReady) return;
    let cancelled = false;
    // Same as the rate read below: a read issued retires the previous verdict
    // for this token, so "balance unavailable" cannot sit over a read in flight.
    setBalanceErrorRead((prev) => (prev?.token === sendToken ? null : prev));
    void (async () => {
      try {
        const next = await publicClient.readContract({
          address: sendTokenAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        });
        if (cancelled) return;
        // Any observed movement answers the question the watch was asking, so
        // it clears here as well as in the poll — that is what lets a manual
        // "check again" retire an `unconfirmed` notice.
        if (next !== balanceRef.current) setBalanceWatch("idle");
        setBalanceRead({ token: sendToken, value: next });
        balanceRef.current = next;
        setBalanceErrorRead(null);
      } catch (err) {
        if (cancelled) return;
        console.warn(`gantry: ${sendToken} balance read failed`, err);
        setBalanceErrorRead({ token: sendToken, message: messageOf(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  // sendTokenAddress is load-bearing here, not incidental: without it a payer
  // who switches to euros keeps reading their USDC balance, and the figure on
  // the wallet screen would describe a token they are no longer paying in.
  // `sendToken` alongside `sendTokenAddress`: they derive from the same
  // currency and always move together, but the warning is worth keeping honest
  // — exhaustive-deps is what caught the original bug where these reads did not
  // follow the token at all.
  }, [address, publicClient, balanceNonce, nonce, sendToken, sendTokenAddress, payCurrencyReady]);

  /* ── The rate and the chain's clock ─────────────────────────────────────
     The rate is read live rather than taken from the seeded constant: it is
     owner-set on FixedRateSwap and one transaction can change it, so a hardcoded
     1.3421 would quietly start lying. The block timestamp is read for the same
     reason `agentStatus` asks for chain time — a laptop minutes ahead would
     render a live policy as lapsed.

     Settled independently of each other. A dropped rate silently restates every
     S$ figure in the product as USDC, so it is surfaced; only the block read
     degrades gracefully — the offset stays 0 and the device's clock is used — so
     that one is logged and not shown. */
  useEffect(() => {
    // `payCurrencyReady` too: until the stored preference has been read,
    // `sendTokenAddress` is the DEFAULT rather than the payer's choice, and
    // reading against it would answer in a token they do not pay in.
    //
    // Deliberately NOT gated on `address`. The rate is a property of the SWAP,
    // not of a payer, and gating it on a signer left `rate` and `rateError` both
    // null forever whenever nobody was connected — which the placeholder below
    // renders as an animated skeleton, i.e. an active claim that data is on its
    // way when nothing had been asked for. Reachable in one action: choose "my
    // own wallet" and connect nothing.
    if (!publicClient || !payCurrencyReady) return;
    let cancelled = false;
    // A read has been ISSUED, so the previous verdict for this token is retired.
    // Clearing only on success left "the rate could not be read" on screen for
    // the whole round-trip of the read that was about to replace it. Scoped to
    // the current token so a stamp for another one is left alone.
    setRateErrorRead((prev) => (prev?.token === sendToken ? null : prev));
    void (async () => {
      const [rateResult, blockResult] = await Promise.allSettled([
        publicClient.readContract({
          address: BASE_SEPOLIA_ADDRESSES.fixedRateSwap,
          abi: fixedRateSwapAbi,
          functionName: "rateOf",
          args: [sendTokenAddress],
        }),
        publicClient.getBlock(),
      ]);
      if (cancelled) return;
      if (rateResult.status === "fulfilled") {
        setRateRead({ token: sendToken, value: rateResult.value });
        setRateErrorRead(null);
      } else {
        console.warn("gantry: FixedRateSwap rate read failed", rateResult.reason);
        setRateErrorRead({ token: sendToken, message: messageOf(rateResult.reason) });
      }
      if (blockResult.status === "fulfilled") {
        setClockOffset(Number(blockResult.value.timestamp) - Math.floor(Date.now() / 1000));
      } else {
        console.warn("gantry: block read failed, falling back to this device's clock", blockResult.reason);
      }
    })();
    return () => {
      cancelled = true;
    };
  // Same reason as the balance read: the rate is per-token, so switching
  // currency has to re-read it or every S$ figure stays converted at the old
  // token's rate. `sendToken` rides along because the result is STAMPED with it.
  }, [address, publicClient, nonce, sendToken, sendTokenAddress, payCurrencyReady]);

  /* A top-up poll belongs to the token it started on.
     `balanceRef` is the baseline the watch compares against, so leaving a USDC
     figure in it across a switch to euros makes the very first EURC read look
     like the movement the poll was waiting for. Retiring the poll and dropping
     the baseline is the honest reset: nothing is known about the new token yet,
     which is the same thing the stamped reads above now say. */
  useEffect(() => {
    balanceRef.current = null;
    pollToken.current += 1;
    setBalanceWatch("idle");
  }, [sendToken]);

  const chainNow = useCallback(
    () => Math.floor(Date.now() / 1000) + clockOffset,
    [clockOffset],
  );

  /* ── Merchant display records ───────────────────────────────────────────
     A settlement row carries a handle, not a shop name, so every list needs a
     lookup. Requests are deduped through a ref rather than through state: two
     rows for the same shop render in one pass, and a state guard would let both
     of them fire before either write landed. */
  const requested = useRef(new Set<string>());
  const ensureMerchant = useCallback((handle: string) => {
    if (!handle || requested.current.has(handle)) return;
    requested.current.add(handle);
    setMerchantErrors((prev) => {
      // `hasOwnProperty`, not `in`: "constructor" is a legal handle and `in`
      // would find it on Object.prototype, returning a new object every call.
      if (!Object.prototype.hasOwnProperty.call(prev, handle)) return prev;
      const next = { ...prev };
      delete next[handle];
      return next;
    });
    api
      .merchant(handle)
      .then((merchant) => setMerchants((prev) => ({ ...prev, [handle]: merchant })))
      .catch((err: unknown) => {
        // ONLY a 404 is "the chain has no such handle". A 12s timeout, a CORS
        // refusal, a captive portal or a cold backend are all failures to ASK,
        // and caching one of those as `null` would tell a payer standing in
        // front of a real shop that it does not exist. Worse, the dedupe ref
        // would hold the handle for the life of the page, so one flaky lookup
        // would brick paying that merchant until a reload.
        if (err instanceof ApiClientError && err.status === 404) {
          setMerchants((prev) => ({ ...prev, [handle]: null }));
          return;
        }
        console.warn(`gantry: merchant lookup failed for ${handle}`, err);
        requested.current.delete(handle);
        setMerchantErrors((prev) => ({ ...prev, [handle]: messageOf(err) }));
      });
  }, []);

  // `hasOwnProperty` for the same reason `merchant` below uses it: "constructor"
  // is a legal handle, and a plain index would answer it from Object.prototype.
  const merchantError = useCallback(
    (handle: string): string | null =>
      Object.prototype.hasOwnProperty.call(merchantErrors, handle)
        ? (merchantErrors[handle] ?? null)
        : null,
    [merchantErrors],
  );

  const retryMerchant = useCallback(
    (handle: string) => {
      // `requested` is a ref, so the delete lands before ensureMerchant reads
      // it — a state guard would let a double tap fire two lookups.
      requested.current.delete(handle);
      ensureMerchant(handle);
    },
    [ensureMerchant],
  );

  const rows = useMemo(
    () => toActivityRows(settlements ?? [], denials),
    [settlements, denials],
  );

  useEffect(() => {
    for (const row of rows) ensureMerchant(row.handle);
  }, [rows, ensureMerchant]);

  /* ── `?receipt=<key>` ───────────────────────────────────────────────────
     The one overlay the URL cannot carry whole. Every other kind is an id the
     app can act on immediately; a receipt is an `ActivityRow`, so a cold load
     names a row that has not been fetched.

     `rowsRef` exists for the Back case rather than the cold one: pressing Back
     onto a receipt the app has had in memory all along should open it, not
     flash a loading screen. The effect below covers the cold case, where the
     key is held until the history arrives. */
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    if (pendingReceiptKey === null) return;
    const row = findActivityRow(rows, pendingReceiptKey);
    // Nothing on a miss. Whether a miss is "not yet" or "not here" is decided by
    // `pendingReceipt` below, off the loading flags, and never by an absence.
    if (!row) return;
    setPendingReceiptKey(null);
    // Grows the stack from empty and adds NO history entry. Depth is 1 on both
    // sides — a pending receipt already counted as one — so the write-back
    // either finds the URL unchanged and does nothing, or REPLACES it with the
    // row's canonical key. A push would put a duplicate entry in front of Back
    // for a screen the payer never navigated to.
    setStack([{ kind: "receipt", row }]);
  }, [pendingReceiptKey, rows]);

  /**
   * Has the history finished answering — for BOTH sources?
   *
   * A receipt key can name a settlement or a refusal, and the two load on
   * different schedules: refusals are fetched per agent wallet, so they cannot
   * even start until the agent enumeration lands. Reporting "not in this
   * wallet's history" off the settlements alone would say it, briefly and
   * wrongly, over every refusal.
   *
   * A failed enumeration counts as answered. We will never get the refusals in
   * that case, and "still loading" forever is a worse answer than a caveated
   * one — the errors the screen also reads are what keep it honest.
   */
  /**
   * Has the history ANSWERED — not merely stopped loading?
   *
   * `settlementsError === null` is load-bearing and was missing. The settlements
   * catch does `setSettlements([])`, which is the sentinel collapse the `agents`
   * field's own doc forbids twelve lines above it: an empty array is the strong
   * claim "we asked, there are none", and a failure must never wear it. Without
   * this clause a payer following a shared `?receipt=` link during a backend
   * blip was told **"That payment isn't in this wallet's history"** — a verdict
   * about the chain derived from a request that never came back.
   *
   * A failed read is reported by `historyFailed` instead, which is a different
   * sentence entirely. Fixing the `[]` collapse at its source is the better
   * repair and is deliberately NOT done here: `settlements` is read by three
   * screens and this is the wrong week to change what null means to them.
   */
  const historyFailed = settlementsError !== null || denialsError !== null || agentsError !== null;
  const historyKnown =
    settlements !== null &&
    settlementsError === null &&
    (agentsError !== null || (agents !== null && (agents.length === 0 || denialsReady)));

  const pendingReceipt = useMemo<PendingReceiptState | null>(
    () =>
      pendingReceiptKey === null
        ? null
        : {
            key: pendingReceiptKey,
            // THREE answers, not two. "unavailable" exists because a history we
            // failed to read is not evidence a payment does not exist, and
            // "missing" is a claim about this wallet that only a completed read
            // can support. Checked FIRST: a run where one page failed and the
            // rest returned is still a run that cannot say "not in this wallet".
            status: historyFailed ? "unavailable" : historyKnown ? "missing" : "loading",
          },
    [pendingReceiptKey, historyKnown, historyFailed],
  );

  // `hasOwnProperty`, not a plain lookup: "constructor", "toString" and
  // "valueOf" are all legal handles under HANDLE_REGEX, and a plain-object index
  // answers those from Object.prototype — a shop that would then render as a
  // function instead of as itself.
  const merchant = useCallback(
    (handle: string): MerchantResponse | null | undefined =>
      Object.prototype.hasOwnProperty.call(merchants, handle) ? merchants[handle] : undefined,
    [merchants],
  );

  /* ── Agent display names ────────────────────────────────────────────────
     Read off the wallet itself. It used to be a localStorage map, which put the
     name in the one place the wallet is not: a rename on the laptop never
     reached the phone, and on a build where every visitor shares one demo key
     that is the same payer seeing one wallet under two names.

     Empty is not a name. The contract lets a label be "", so `||` and not `??` —
     otherwise an unnamed wallet renders as a blank row rather than falling back
     to its address. */
  const agentName = useCallback(
    (wallet: Address) =>
      (agents ?? []).find((a) => a.wallet.toLowerCase() === wallet.toLowerCase())?.label || null,
    [agents],
  );

  /* ── Freshness after a write the payer signed ───────────────────────────
     Keyed by lowercased wallet: the address arrives from a route segment, a
     chain read and a form, and only one of those is reliably checksummed. */
  const agentExpectation = useCallback(
    (wallet: Address) => expectations[wallet.toLowerCase()] ?? null,
    [expectations],
  );


  const expectAgentPolicy = useCallback(
    (wallet: Address, written: ExpectedAgentState, policyWritten: boolean) => {
    const entry: AgentExpectation = {
      fingerprint: policyFingerprint(written),
      proven: provenAgentFields(written, policyWritten),
      at: Date.now(),
    };
    setExpectations((prev) => ({ ...prev, [wallet.toLowerCase()]: entry }));
  }, []);

  const settleAgentExpectation = useCallback((wallet: Address, settledBy?: AgentSummary) => {
    // The read that ENDED the wait also replaces the row, in the same update.
    //
    // Clearing the flag without the data is what let a confirmed rename read as
    // ignored: the detail screen polls `api.agent(wallet)` into its own local
    // state and then settles this store-wide flag, so every other consumer lost
    // the flag while still holding the row from before the write, and rendered
    // the old name beside the new caps as fact.
    //
    // The screen-level guard that comment used to name is gone — the store
    // reconciles `agents` now, so there is no per-screen flag to lose — but the
    // merge stays, because it is what makes the row the settling read agreed
    // with the row every consumer sees.
    //
    // Only a read that MATCHED the fingerprint may be passed here. A read we
    // have just declared stale (the waited-out branch) must not be promoted
    // into shared state: the detail screen carries a notice saying its figures
    // may be a moment old, and the list has nowhere to put one.
    if (settledBy) {
      setAgentsRead((prev) =>
        prev === null
          ? prev
          : prev.map((agent) =>
              agent.wallet.toLowerCase() === settledBy.wallet.toLowerCase() ? settledBy : agent,
            ),
      );
    }
    setExpectations((prev) => {
      const key = wallet.toLowerCase();
      // Returning `prev` unchanged matters: this is called from a fetch effect,
      // and a fresh object every time would re-run every consumer of the store
      // on every poll.
      if (!Object.prototype.hasOwnProperty.call(prev, key)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const value = useMemo<PayerStore>(
    () => ({
      identity,
      agents,
      agentsError,
      agentsUnreadable,
      settlements,
      settlementsError,
      denials,
      denialsError,
      rows,
      balance,
      balanceError,
      rate,
      rateError,
      payCurrency,
      setPayCurrency,
      payCurrencyReady,
      sendToken,
      balanceWatch,
      chainNow,
      merchant,
      ensureMerchant,
      merchantError,
      retryMerchant,
      agentName,
      agentExpectation,
      agentAhead,
      expectAgentPolicy,
      settleAgentExpectation,
      refresh,
      refreshHistory,
      refreshBalance,
      overlay: stack.length > 0 ? stack[stack.length - 1]! : null,
      pushOverlay,
      replaceOverlay,
      popOverlay,
      closeOverlays,
      pendingReceipt,
      linkRefused,
      clearLinkRefused,
    }),
    [
      identity,
      agents,
      agentsError,
      agentsUnreadable,
      settlements,
      settlementsError,
      denials,
      denialsError,
      rows,
      balance,
      balanceError,
      rate,
      rateError,
      payCurrency,
      setPayCurrency,
      payCurrencyReady,
      sendToken,
      balanceWatch,
      chainNow,
      merchant,
      ensureMerchant,
      merchantError,
      retryMerchant,
      agentName,
      agentExpectation,
      agentAhead,
      expectAgentPolicy,
      settleAgentExpectation,
      refresh,
      refreshHistory,
      refreshBalance,
      stack,
      pushOverlay,
      replaceOverlay,
      popOverlay,
      closeOverlays,
      pendingReceipt,
      linkRefused,
      clearLinkRefused,
    ],
  );

  return <PayerContext.Provider value={value}>{children}</PayerContext.Provider>;
}
