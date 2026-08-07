/** NEXT_PUBLIC_* accessors. Statically referenced so Next can inline them. */

export function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

export function backendUrl(): string {
  return process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";
}

/**
 * One knob: NEXT_PUBLIC_BURNER holds the burner's private key, and holding one
 * is what turns the burner on. `0`, unset, or anything that is not a
 * 0x-prefixed 32-byte key leaves it off — a malformed value must never quietly
 * change which account signs. `?burner=1` still opts in per visit, using a
 * per-device key instead.
 */
export function burnerEnvKey(): `0x${string}` | undefined {
  const raw = process.env.NEXT_PUBLIC_BURNER;
  if (!raw || raw === "0") return undefined;
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return raw as `0x${string}`;
  console.warn(
    "NEXT_PUBLIC_BURNER is set but is not a 0x-prefixed 32-byte key — the burner stays off.",
  );
  return undefined;
}

export function burnerEnvEnabled(): boolean {
  return burnerEnvKey() !== undefined;
}

export function walletPayToken(): "USDC" | "MUSDC" | "XSGD" {
  const token = process.env.NEXT_PUBLIC_PAY_TOKEN;
  return token === "MUSDC" || token === "XSGD" ? token : "USDC";
}

export function walletConnectProjectId(): string {
  return process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "gantry-dev-placeholder";
}
