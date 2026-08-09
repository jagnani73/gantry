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
import { erc20Abi, type Address } from "viem";
import { usePublicClient } from "wagmi";
import {
  BASE_SEPOLIA_ADDRESSES,
  fixedRateSwapAbi,
  type AgentSummary,
  type DenialEvent,
  type MerchantResponse,
  type SettlementEvent,
} from "@gantry/shared";
import { api, ApiClientError } from "@/lib/api";
import { toActivityRows, type ActivityRow } from "./activity";
import { usePayerIdentity, type PayerIdentity } from "./identity";

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
  | { kind: "pay"; handle: string }
  | { kind: "receipt"; row: ActivityRow }
  | { kind: "merchant"; handle: string }
  | { kind: "agent"; wallet: Address }
  /** null = create a new agent; an address = edit that wallet's rules. */
  | { kind: "agentForm"; wallet: Address | null };

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

  /** Payer's USDC balance in 6dp units; null until the read lands. */
  balance: bigint | null;
  /** Non-null when the balance READ failed, which is not the same as "not yet"
   * — a screen showing "reading balance…" off `balance === null` alone spins
   * forever on a dead RPC. */
  balanceError: string | null;
  /** OWNER-SET XSGD-per-USDC rate from FixedRateSwap; null if the read failed —
   * in which case no S$ conversion may be rendered at all. */
  rate: bigint | null;
  /** Non-null when the rate READ failed. Every S$ figure in the app is this
   * conversion, so a silent failure quietly restates the whole product in USDC. */
  rateError: string | null;
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

  agentName(wallet: Address): string | null;
  setAgentName(wallet: Address, name: string): void;

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
}

const PayerContext = createContext<PayerStore | null>(null);

export function usePayer(): PayerStore {
  const store = useContext(PayerContext);
  if (!store) throw new Error("usePayer must be used inside <PayerProvider>");
  return store;
}

const AGENT_NAMES_KEY = "gantry.agent.names";

/** Newest page only. The design has no "load older" control, and 100 rows is
 * well past what a demo wallet accumulates — paging is an easy addition later,
 * every row already carries the cursor it would need. */
const HISTORY_LIMIT = 100;

/** Bounded, and sized like the pay flow's own post-funding wait: a transfer
 * that has not surfaced after this long is reported as unconfirmed rather than
 * polled forever — see `balanceWatch`, which is what carries that answer to a
 * screen. */
const BALANCE_POLL_ATTEMPTS = 8;
const BALANCE_POLL_MS = 1_500;

export type BalanceWatch = "idle" | "watching" | "unconfirmed";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function PayerProvider({
  children,
  initialOverlay,
}: {
  children: ReactNode;
  initialOverlay?: Overlay;
}) {
  const identity = usePayerIdentity();
  const publicClient = usePublicClient();
  const address = identity.address;

  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentsUnreadable, setAgentsUnreadable] = useState<Address[]>([]);
  const [settlements, setSettlements] = useState<SettlementEvent[] | null>(null);
  const [settlementsError, setSettlementsError] = useState<string | null>(null);
  const [denials, setDenials] = useState<DenialEvent[]>([]);
  const [denialsError, setDenialsError] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [rate, setRate] = useState<bigint | null>(null);
  const [rateError, setRateError] = useState<string | null>(null);
  const [balanceWatch, setBalanceWatch] = useState<BalanceWatch>("idle");
  const [merchants, setMerchants] = useState<Record<string, MerchantResponse | null>>({});
  const [merchantErrors, setMerchantErrors] = useState<Record<string, string>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [clockOffset, setClockOffset] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [historyNonce, setHistoryNonce] = useState(0);
  const [balanceNonce, setBalanceNonce] = useState(0);

  // Overlays are a stack so "receipt → about this shop → back" lands on the
  // receipt rather than dumping the payer onto a tab they never chose.
  const [stack, setStack] = useState<Overlay[]>(initialOverlay ? [initialOverlay] : []);

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
     on a phone for one row a minute is the wrong trade. A poll of the HISTORY
     only (never the agent enumeration, which walks a block range) covers it, and
     it stops while the tab is hidden so a pocketed phone is not calling the
     backend every twenty seconds. */
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") setHistoryNonce((n) => n + 1);
    };
    const timer = setInterval(tick, 20_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  const pushOverlay = useCallback((overlay: Overlay) => setStack((s) => [...s, overlay]), []);
  const replaceOverlay = useCallback(
    (overlay: Overlay) => setStack((s) => [...s.slice(0, -1), overlay]),
    [],
  );
  const popOverlay = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  const closeOverlays = useCallback(() => setStack([]), []);

  /* ── Agent wallets ──────────────────────────────────────────────────────
     Enumerated from WalletCreated logs, so a cold call walks a block range and
     can take seconds. Screens must render a loading state off `agents === null`
     rather than flashing "no agents" at a payer who has three.

     `unreadable` is carried, never dropped. A wallet that holds code and did not
     answer is a failed READ, and folding it into an empty `agents` tells a payer
     who owns an agent that they own none — beside a Create button. */
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    setAgentsError(null);
    api
      .agents({ owner: address })
      .then((res) => {
        if (cancelled) return;
        setAgents(res.agents);
        setAgentsUnreadable(res.unreadable ?? []);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // NOT `[]`. This state means "we do not know", and `[]` means "we asked
        // and there are none" — the distinction this very field documents. It
        // leaks past the agents screen: `payerFilter` below is built from this
        // list, and a PBM payment's on-chain payer is the WALLET, so an empty
        // list silently narrows the history query to the human address and drops
        // every agent payment out of Activity with nothing on screen saying so.
        setAgents(null);
        // The whole enumeration failed, so there is no per-wallet verdict to
        // report; `agentsError` is the one that has to be on screen.
        setAgentsUnreadable([]);
        setAgentsError(messageOf(err));
      });
    return () => {
      cancelled = true;
    };
  }, [address, nonce]);

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
     produces no event and no log to sweep, so this row is the ONLY trace it
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
    if (!address || !publicClient) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await publicClient.readContract({
          address: BASE_SEPOLIA_ADDRESSES.realUsdc,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        });
        if (cancelled) return;
        // Any observed movement answers the question the watch was asking, so
        // it clears here as well as in the poll — that is what lets a manual
        // "check again" retire an `unconfirmed` notice.
        if (next !== balanceRef.current) setBalanceWatch("idle");
        setBalance(next);
        balanceRef.current = next;
        setBalanceError(null);
      } catch (err) {
        if (cancelled) return;
        console.warn("gantry: USDC balance read failed", err);
        setBalanceError(messageOf(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, publicClient, balanceNonce, nonce]);

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
    if (!address || !publicClient) return;
    let cancelled = false;
    void (async () => {
      const [rateResult, blockResult] = await Promise.allSettled([
        publicClient.readContract({
          address: BASE_SEPOLIA_ADDRESSES.fixedRateSwap,
          abi: fixedRateSwapAbi,
          functionName: "rateOf",
          args: [BASE_SEPOLIA_ADDRESSES.realUsdc],
        }),
        publicClient.getBlock(),
      ]);
      if (cancelled) return;
      if (rateResult.status === "fulfilled") {
        setRate(rateResult.value);
        setRateError(null);
      } else {
        console.warn("gantry: FixedRateSwap rate read failed", rateResult.reason);
        setRateError(messageOf(rateResult.reason));
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
  }, [address, publicClient, nonce]);

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
     "Kopi Runner" is the payer's private label for a wallet they own, so it is
     kept in this browser and nowhere else — no table, no endpoint, and no
     question about who is allowed to rename someone's agent. */
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(AGENT_NAMES_KEY);
      if (raw) setNames(JSON.parse(raw) as Record<string, string>);
    } catch {
      // A corrupted or unreadable map costs a nickname, nothing more.
    }
  }, []);

  const agentName = useCallback(
    (wallet: Address) => names[wallet.toLowerCase()] ?? null,
    [names],
  );

  const setAgentName = useCallback((wallet: Address, name: string) => {
    setNames((prev) => {
      const next = { ...prev, [wallet.toLowerCase()]: name };
      try {
        // Written inside the updater so the stored map and the rendered one can
        // never disagree. Idempotent, which is what makes that safe under
        // StrictMode's double invocation.
        window.localStorage.setItem(AGENT_NAMES_KEY, JSON.stringify(next));
      } catch {
        // Private mode: the name lives for this session and that is fine.
      }
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
      balanceWatch,
      chainNow,
      merchant,
      ensureMerchant,
      merchantError,
      retryMerchant,
      agentName,
      setAgentName,
      refresh,
      refreshHistory,
      refreshBalance,
      overlay: stack.length > 0 ? stack[stack.length - 1]! : null,
      pushOverlay,
      replaceOverlay,
      popOverlay,
      closeOverlays,
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
      balanceWatch,
      chainNow,
      merchant,
      ensureMerchant,
      merchantError,
      retryMerchant,
      agentName,
      setAgentName,
      refresh,
      refreshHistory,
      refreshBalance,
      stack,
      pushOverlay,
      replaceOverlay,
      popOverlay,
      closeOverlays,
    ],
  );

  return <PayerContext.Provider value={value}>{children}</PayerContext.Provider>;
}
