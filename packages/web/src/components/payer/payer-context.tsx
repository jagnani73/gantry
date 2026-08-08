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

  /** null while loading; an empty array is a real "no agents". */
  agents: AgentSummary[] | null;
  agentsError: string | null;
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
  /** Drops the dedupe entry and looks the handle up again. The failed lookup
   * releases the handle, so this is the only thing standing between one flaky
   * request and a shop that can never be paid for the life of the page. */
  retryMerchant(handle: string): void;

  agentName(wallet: Address): string | null;
  setAgentName(wallet: Address, name: string): void;

  /** Re-reads everything, agent enumeration included. For a policy write. */
  refresh(): void;
  /** Re-reads only the settlement and denial pages. For a payment, which cannot
   * have changed which wallets the payer owns. */
  refreshHistory(): void;
  refreshBalance(): void;

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
  const [settlements, setSettlements] = useState<SettlementEvent[] | null>(null);
  const [settlementsError, setSettlementsError] = useState<string | null>(null);
  const [denials, setDenials] = useState<DenialEvent[]>([]);
  const [denialsError, setDenialsError] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [rate, setRate] = useState<bigint | null>(null);
  const [rateError, setRateError] = useState<string | null>(null);
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
  const refreshBalance = useCallback(() => setBalanceNonce((n) => n + 1), []);

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
     rather than flashing "no agents" at a payer who has three. */
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    setAgentsError(null);
    api
      .agents({ owner: address })
      .then((res) => {
        if (!cancelled) setAgents(res.agents);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setAgents([]);
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

  /* ── Balance, rate and the chain's clock ────────────────────────────────
     The rate is read live rather than taken from the seeded constant: it is
     owner-set on FixedRateSwap and one transaction can change it, so a hardcoded
     1.3421 would quietly start lying. The block timestamp is read for the same
     reason `agentStatus` asks for chain time — a laptop minutes ahead would
     render a live policy as lapsed.

     All three are settled independently and each failure is BOTH logged and
     surfaced: a dropped balance leaves the wallet screen reading "reading
     balance…" for as long as the app is open, and a dropped rate silently
     restates every S$ figure in the product as USDC. Only the block read
     degrades gracefully — the offset stays 0 and the laptop's clock is used —
     so it is logged and not shown. */
  useEffect(() => {
    if (!address || !publicClient) return;
    let cancelled = false;
    void (async () => {
      const [balanceResult, rateResult, blockResult] = await Promise.allSettled([
        publicClient.readContract({
          address: BASE_SEPOLIA_ADDRESSES.realUsdc,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        }),
        publicClient.readContract({
          address: BASE_SEPOLIA_ADDRESSES.fixedRateSwap,
          abi: fixedRateSwapAbi,
          functionName: "rateOf",
          args: [BASE_SEPOLIA_ADDRESSES.realUsdc],
        }),
        publicClient.getBlock(),
      ]);
      if (cancelled) return;
      if (balanceResult.status === "fulfilled") {
        setBalance(balanceResult.value);
        setBalanceError(null);
      } else {
        console.warn("gantry: USDC balance read failed", balanceResult.reason);
        setBalanceError(messageOf(balanceResult.reason));
      }
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
        console.warn("gantry: block read failed — falling back to this device's clock", blockResult.reason);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, publicClient, balanceNonce, nonce]);

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
      settlements,
      settlementsError,
      denials,
      denialsError,
      rows,
      balance,
      balanceError,
      rate,
      rateError,
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
      settlements,
      settlementsError,
      denials,
      denialsError,
      rows,
      balance,
      balanceError,
      rate,
      rateError,
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
