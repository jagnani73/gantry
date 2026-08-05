import type {
  ApiErrorBody,
  CreateIntentRequest,
  FaucetResponse,
  IntentResponse,
  IntentStatusResponse,
  MerchantResponse,
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
  return body as T;
}

export const api = {
  merchant: (handle: string) => call<MerchantResponse>(`/api/merchants/${handle}`),
  createIntent: (req: CreateIntentRequest) =>
    call<IntentResponse>("/api/intents", { method: "POST", body: JSON.stringify(req) }),
  intentStatus: (intentId: string) => call<IntentStatusResponse>(`/api/intents/${intentId}`),
  settle: (intentId: string, req: SettleRequest) =>
    call<SettleResponse>(`/api/intents/${intentId}/settle`, {
      method: "POST",
      body: JSON.stringify(req),
    }),
  requote: (intentId: string) =>
    call<IntentResponse>(`/api/intents/${intentId}/requote`, { method: "POST", body: "{}" }),
  faucet: (address: string) =>
    call<FaucetResponse>("/api/faucet", { method: "POST", body: JSON.stringify({ address }) }),
};
