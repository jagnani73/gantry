/** NEXT_PUBLIC_* accessors. Statically referenced so Next can inline them. */

export function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

export function backendUrl(): string {
  return process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";
}

export function burnerEnvEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BURNER === "1";
}

export function burnerEnvKey(): `0x${string}` | undefined {
  const key = process.env.NEXT_PUBLIC_BURNER_KEY;
  return key && /^0x[0-9a-fA-F]{64}$/.test(key) ? (key as `0x${string}`) : undefined;
}

export function walletPayToken(): "USDC" | "MUSDC" | "XSGD" {
  const token = process.env.NEXT_PUBLIC_PAY_TOKEN;
  return token === "MUSDC" || token === "XSGD" ? token : "USDC";
}

export function walletConnectProjectId(): string {
  return process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "gantry-dev-placeholder";
}
