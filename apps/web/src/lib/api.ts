import type {
  ApiErrorBody,
  CreateIntentRequest,
  FaucetResponse,
  IntentResponse,
  MerchantResponse,
  PolicyResponse,
  RevokePolicyResponse,
  SettleRequest,
  SettleResponse,
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

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${backendUrl()}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
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
  merchant: (handle: string) => call<MerchantResponse>(`/api/merchants/${handle}`),
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
  policy: () => call<PolicyResponse>("/api/policy"),
  revokePolicy: () =>
    call<RevokePolicyResponse>("/api/policy/revoke", { method: "POST", body: "{}" }),
};
