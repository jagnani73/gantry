/** NEXT_PUBLIC_* accessors. Statically referenced so Next can inline them. */

export function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

export function backendUrl(): string {
  return process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";
}

/**
 * The burner is configured by exactly one value, with no URL override — env and
 * URL can never disagree about which account signs:
 *   `1`          → on, with a per-device key persisted in localStorage
 *   `0x…` (32B)  → on, pinned to that account
 *   `0`/unset    → off
 *   anything else→ off, and say so; a typo must never silently change the payer
 */
type BurnerConfig = { on: false } | { on: true; key?: `0x${string}` };

let warned = false;

function burnerConfig(): BurnerConfig {
  const raw = process.env.NEXT_PUBLIC_BURNER;
  if (!raw || raw === "0") return { on: false };
  if (raw === "1") return { on: true };
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return { on: true, key: raw as `0x${string}` };
  if (!warned) {
    warned = true;
    console.warn(
      `NEXT_PUBLIC_BURNER="${raw}" is neither 1 nor a 0x-prefixed 32-byte key — the burner stays off.`,
    );
  }
  return { on: false };
}

export function burnerEnvEnabled(): boolean {
  return burnerConfig().on;
}

export function burnerEnvKey(): `0x${string}` | undefined {
  const config = burnerConfig();
  return config.on ? config.key : undefined;
}

export function walletConnectProjectId(): string {
  return process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "gantry-dev-placeholder";
}
