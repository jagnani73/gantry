import type {
  TokenId,
  AgentListResponse,
  AgentSummary,
  ApiErrorBody,
  CreateIntentRequest,
  DenialListResponse,
  FaucetGasResponse,
  FaucetResponse,
  IntentResponse,
  MerchantListResponse,
  MerchantResponse,
  RegisterMerchantRequest,
  RegisterMerchantResponse,
  SettleRequest,
  SettleResponse,
  SettlementListResponse,
  SettlementSummaryResponse,
  UpdateMerchantProfileRequest,
} from "@gantry/shared";
import type { Address } from "viem";
import { backendUrl } from "./env";

/** Drops absent params rather than sending `?handle=undefined` — the settlement
 * route refuses a present-but-empty filter on purpose, so a stringified
 * `undefined` would be a 400 rather than "no filter". */
function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly errorName: string;
  readonly args?: unknown;

  constructor(status: number, body: ApiErrorBody["error"] | undefined) {
    super(body?.message ?? `request failed (${status})`);
    this.status = status;
    this.errorName = body?.name ?? "InternalError";
    this.args = body?.args;
  }
}

/**
 * `timeoutMs` is opt-in per call, deliberately. A dropped connection leaves
 * fetch pending until the OS gives up (minutes), which pins a caller's UI in a
 * loading state with no way out — but the settle path legitimately waits on a
 * relayer transaction plus stale-state retries, so it keeps its unbounded wait
 * rather than risking a spurious abort on the demo spine.
 */
async function call<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const { timeoutMs, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(`${backendUrl()}${path}`, {
      ...rest,
      ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
      headers: { "content-type": "application/json", ...rest.headers },
    });
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    throw new ApiClientError(0, {
      name: timedOut ? "RequestTimeout" : "NetworkError",
      message: timedOut
        ? `the backend did not respond within ${Math.round((timeoutMs ?? 0) / 1000)}s`
        : err instanceof Error
          ? err.message
          : String(err),
    });
  }
  const body = (await res.json().catch(() => undefined)) as T | ApiErrorBody | undefined;
  if (!res.ok) {
    throw new ApiClientError(res.status, (body as ApiErrorBody | undefined)?.error);
  }
  if (body === undefined) {
    // A 200 with a non-JSON body (captive portal, wrong URL) must surface as
    // an error card, not crash the next render with undefined data.
    throw new ApiClientError(res.status, {
      name: "BadResponse",
      message: "non-JSON response from backend. Check NEXT_PUBLIC_BACKEND_URL",
    });
  }
  return body as T;
}

export const api = {
  merchant: (handle: string) => call<MerchantResponse>(`/api/merchants/${handle}`, { timeoutMs: 12_000 }),
  /**
   * The whole directory in one call — no filter, no page. A longer timeout than
   * the single-handle lookup because this is often a visitor's FIRST request to
   * a free-tier host that spins down when idle, so it can be paying a ~50s cold
   * start rather than doing any work.
   */
  merchants: () => call<MerchantListResponse>("/api/merchants", { timeoutMs: 60_000 }),
  registerMerchant: (req: RegisterMerchantRequest) =>
    call<RegisterMerchantResponse>("/api/merchants", {
      method: "POST",
      body: JSON.stringify(req),
      // Registration waits on a real receipt; the relayer caps that at 20s.
      timeoutMs: 45_000,
    }),
  createIntent: (req: CreateIntentRequest) =>
    call<IntentResponse>("/api/intents", { method: "POST", body: JSON.stringify(req) }),
  settle: (intentId: string, req: SettleRequest) =>
    call<SettleResponse>(`/api/intents/${intentId}/settle`, {
      method: "POST",
      body: JSON.stringify(req),
    }),
  requote: (intentId: string) =>
    call<IntentResponse>(`/api/intents/${intentId}/requote`, { method: "POST", body: "{}" }),
  /** `token` funds the currency the payer actually pays in — omitting it would
   * hand someone paying in euros a USDC balance they cannot spend. */
  faucet: (address: string, token?: TokenId) =>
    call<FaucetResponse>("/api/faucet", {
      method: "POST",
      body: JSON.stringify({ address, token }),
    }),

  /**
   * Gas only. Use this — never `faucet()` — when the caller needs to SEND a
   * transaction rather than pay one: it never touches the scarce USDC ceiling
   * or its cooldown, and it refuses in gas vocabulary. Calling `faucet()` for
   * gas is how a payer who paid 30 seconds ago gets a 429 about USDC when they
   * tap Revoke.
   */
  faucetGas: (address: string) =>
    call<FaucetGasResponse>("/api/faucet/gas", {
      method: "POST",
      body: JSON.stringify({ address }),
    }),

  // 45s, matching registerMerchant and for the identical reason: this waits on a
  // real receipt and the relayer caps that at 20s, behind a FIFO queue it shares
  // with settlements. The old 12s was a READ-path timeout left in place when this
  // became a chain write, so exceeding it was the normal outcome under any queue
  // contention — aborting client-side on a write that then landed, which is
  // precisely the false "failed" the screen's own copy warns about.
  updateMerchantProfile: (handle: string, req: UpdateMerchantProfileRequest) =>
    call<MerchantResponse>(`/api/merchants/${handle}`, {
      method: "PATCH",
      body: JSON.stringify(req),
      timeoutMs: 45_000,
    }),

  /**
   * Paged settlement history. `payer` takes several addresses because a row
   * matches on either the on-chain payer or the bridged agent payer — that is
   * how "me and my agents" is one request rather than a client-side union of
   * two pages that would page independently and interleave wrongly.
   */
  settlements: (params: {
    handle?: string;
    payer?: readonly string[];
    before?: string;
    limit?: number;
  }) =>
    call<SettlementListResponse>(
      `/api/settlements${query({
        handle: params.handle,
        payer: params.payer?.length ? params.payer.join(",") : undefined,
        before: params.before,
        limit: params.limit,
      })}`,
      { timeoutMs: 12_000 },
    ),

  /**
   * Totals over the whole matching book from `since` — the merchant Overview's
   * KPI tiles.
   *
   * Deliberately NOT derived from `settlements()` above. Those rows are a page,
   * and summing a page while labelling the result as a span of time is the bug
   * this replaced: the figures moved when the page size changed. `since` is
   * chosen by the caller because the window belongs beside the label naming it.
   */
  settlementSummary: (params: { handle?: string; payer?: readonly string[]; since: number }) =>
    call<SettlementSummaryResponse>(
      `/api/settlements/summary${query({
        handle: params.handle,
        payer: params.payer?.length ? params.payer.join(",") : undefined,
        since: params.since,
      })}`,
      { timeoutMs: 12_000 },
    ),

  /** Refused agent payments — payer-side only; the merchant surface never calls this. */
  denials: (wallet: Address) =>
    call<DenialListResponse>(`/api/denials${query({ wallet })}`, { timeoutMs: 12_000 }),

  /**
   * Enumerated from WalletCreated logs, so a cold call can take seconds.
   *
   * The response has TWO lists and a caller that reads only `agents` is wrong:
   * `unreadable` holds wallets that carry code and did not answer, and folding
   * those into an empty `agents` tells a payer who owns an agent that they own
   * none — beside a button that deploys another one.
   */
  agents: (filter: { owner?: Address; agentSigner?: Address }) =>
    call<AgentListResponse>(`/api/agents${query(filter)}`, { timeoutMs: 20_000 }),

  agent: (wallet: Address) =>
    call<AgentSummary>(`/api/agents/${wallet}`, { timeoutMs: 12_000 }),
};
