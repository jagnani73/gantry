import type {
  ApiErrorBody,
  CreateIntentRequest,
  FaucetResponse,
  IntentResponse,
  MerchantResponse,
  PolicyResponse,
  RegisterMerchantRequest,
  RegisterMerchantResponse,
  RevokePolicyResponse,
  SettleRequest,
  SettleResponse,
  SetPolicyRequest,
  SetPolicyResponse,
} from "@gantry/shared";
import { backendUrl } from "./env";

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
      message: "non-JSON response from backend — check NEXT_PUBLIC_BACKEND_URL",
    });
  }
  return body as T;
}

export const api = {
  merchant: (handle: string) => call<MerchantResponse>(`/api/merchants/${handle}`, { timeoutMs: 12_000 }),
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
  faucet: (address: string) =>
    call<FaucetResponse>("/api/faucet", { method: "POST", body: JSON.stringify({ address }) }),
  policy: () => call<PolicyResponse>("/api/policy", { timeoutMs: 8_000 }),
  setPolicy: (req: SetPolicyRequest) =>
    call<SetPolicyResponse>("/api/policy", { method: "POST", body: JSON.stringify(req) }),
  revokePolicy: () =>
    call<RevokePolicyResponse>("/api/policy/revoke", { method: "POST", body: "{}" }),
};
