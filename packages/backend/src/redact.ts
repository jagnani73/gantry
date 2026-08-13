/**
 * Keeping the RPC credential out of anything that leaves the process.
 *
 * The primary RPC is an Alchemy endpoint whose API key sits in the URL PATH, so
 * the URL *is* the credential. Two viem behaviours turn that into a disclosure:
 *
 *   1. `BaseError.message` is `shortMessage` PLUS `metaMessages`, and a
 *      transport failure's metaMessages carry `URL: <rpc url>`. viem's own
 *      `getUrl()` strips basic-auth userinfo only — an Alchemy key is not
 *      userinfo, so nothing redacts it. Any handler that serialises
 *      `err.message` into a response body ships the key to the caller.
 *   2. `console.error("...", err)` prints the `[cause]` chain via
 *      `util.inspect`, so the URL reaches the log stream even when the outer
 *      message is clean — a strictly WIDER trigger than the HTTP half.
 *
 * Two different answers, on purpose:
 *
 * - `safeMessage` is explicit, and every wire payload calls it. What crosses a
 *   trust boundary should be chosen at the call site, not filtered behind one.
 * - `installLogRedaction` is a choke point, because the log half is ~16 call
 *   sites today and every future `console.error(msg, err)` is another. That is
 *   not maintainable by discipline, and a missed one is silent.
 *
 * This module deliberately imports NO config and touches NO chain: `errors.ts`
 * depends on it, and `errors.test.ts` pins that `errors.ts` stays free of both
 * (`config.ts` calls `process.exit(1)` without an RPC URL, which would take the
 * whole suite down in CI). The secrets are handed in at boot instead. With none
 * registered — every unit test — `redactSecrets` is the identity function and
 * `safeMessage` still does the load-bearing half.
 */
import { inspect } from "node:util";
import { BaseError } from "viem";

/** Longest first, so a full URL is replaced before the bare key inside it. */
let secrets: readonly string[] = [];

/**
 * Register the values that must never appear in output. Called once at boot
 * with the configured RPC endpoints.
 *
 * A URL with NO path carries no embedded credential and is skipped entirely.
 * That is not an optimisation: `https://sepolia.base.org` is appended to every
 * fallback chain, and it is the node that actually serves each 1,999-block
 * sweep chunk — redacting its hostname would blind the logs for the endpoint
 * carrying the correctness path, to hide something that is not a secret.
 *
 * A URL WITH a path contributes its own text and, when the last segment is long
 * enough to be a credential rather than a route ("v2", "rpc"), that segment on
 * its own — a bare key outlives the URL it came from via a different scheme, a
 * trailing query string, or a provider echoing it back.
 *
 * A value that does not parse as a URL is treated as an opaque secret.
 */
export function registerSecrets(values: readonly (string | undefined)[]): void {
  const found = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    let parsed: URL | null = null;
    try {
      parsed = new URL(value);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      found.add(value);
      continue;
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    found.add(value);
    const last = segments[segments.length - 1]!;
    // Comfortably below an Alchemy/Infura key, comfortably above a route.
    if (last.length >= 16) found.add(last);
  }
  secrets = [...found].sort((a, b) => b.length - a.length);
}

/** Replace every registered secret with a marker. Identity when none are set. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out;
}

/**
 * The message a failure may be shown to a caller.
 *
 * `shortMessage` is the same sentence as `message` without viem's metaMessages
 * block — which is where the URL lives — so it is both safer and the more
 * readable of the two. The redaction pass behind it covers errors that never
 * were a `BaseError` (something rethrowing a viem message as a plain `Error`)
 * and any future viem that folds a URL into `shortMessage`.
 */
export function safeMessage(err: unknown): string {
  const raw =
    err instanceof BaseError
      ? err.shortMessage
      : err instanceof Error
        ? err.message
        : String(err);
  return redactSecrets(raw);
}

let installed = false;

/**
 * Route console output through the redactor.
 *
 * Objects are inspected here rather than handed to console, because console
 * would inspect them itself — after we have lost the chance to scrub the
 * result. Depth 5 keeps a viem cause chain legible; nothing is dropped, only
 * the credential is masked.
 */
export function installLogRedaction(): void {
  if (installed) return;
  installed = true;
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") return redactSecrets(value);
    if (typeof value === "object" && value !== null) {
      return redactSecrets(inspect(value, { depth: 5 }));
    }
    return value;
  };
  for (const level of ["error", "warn", "log", "info", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      original(...args.map(scrub));
    };
  }
}
