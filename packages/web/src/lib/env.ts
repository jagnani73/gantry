/** NEXT_PUBLIC_* accessors. Statically referenced so Next can inline them. */

export function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

export function backendUrl(): string {
  return process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";
}

/**
 * The demo account is configured by exactly one value, with no URL override —
 * env and URL can never disagree about which account signs:
 *   `0x…` (32B)  → on, pinned to that account
 *   `0`/unset    → off; the payer connects their own wallet
 *   anything else→ off, and say so; a typo must never silently change the payer
 *
 * There is no per-device mode. It existed when the demo account was a throwaway
 * burner, but agents are now owned on-chain by their payer, and a fresh random
 * address owns nothing and has no history — so every screen built on that
 * ownership would render permanently empty.
 *
 * NOTE: `NEXT_PUBLIC_*` is inlined into the client bundle at build time, so this
 * key is readable by anyone who opens devtools on a deployed build. That is
 * acceptable ONLY because it is a demo account holding testnet funds. Never put
 * a key here that holds anything else, and never reuse the relayer's.
 */
let warned = false;

export function demoKey(): `0x${string}` | undefined {
  const raw = process.env.NEXT_PUBLIC_DEMO_KEY;
  if (!raw || raw === "0") return undefined;
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return raw as `0x${string}`;
  if (!warned) {
    warned = true;
    console.warn(
      `NEXT_PUBLIC_DEMO_KEY="${raw}" is not a 0x-prefixed 32-byte key — the demo account stays off.`,
    );
  }
  return undefined;
}

export function demoAccountEnabled(): boolean {
  return demoKey() !== undefined;
}

export function walletConnectProjectId(): string {
  return process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "gantry-dev-placeholder";
}
