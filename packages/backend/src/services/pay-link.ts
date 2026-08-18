/**
 * The pay link: one URL a person and a machine can both pay.
 *
 * `GET /pay/:handle?sgd=4.50` answers a browser with a redirect into the payer
 * app and answers everything else with the x402 402 challenge. Same URL, same
 * shop, same amount, same settlement function — the convergence the project
 * claims, reduced to something a reader can try with two commands.
 *
 * Pure and config-free, like facilitator-core: the route reads the request, this
 * module decides, and both halves are unit-testable without a server. Every
 * function here is a decision that was wrong at least once in review.
 */

/**
 * Does this client want a page rather than a payment challenge?
 *
 * Deliberately NOT `req.accepts("text/html")`: Express answers that with
 * "text/html" for a bare wildcard Accept, which is what curl and most agent
 * HTTP clients send — so the naive form hands an AI agent a redirect to an HTML
 * page and the machine door silently disappears. The rule is therefore the
 * strict one: only a client that NAMES html gets the page, and everything else
 * — including a missing header — falls through to the 402.
 *
 * `q=0` is honoured because it is the only way a client can say "not this": a
 * wildcard Accept carrying `text/html;q=0` means explicitly no HTML, and
 * reading that as a request for HTML would be backwards.
 */
export function prefersHtml(accept: string | undefined): boolean {
  if (!accept) return false;
  for (const entry of accept.split(",")) {
    const [rawType, ...params] = entry.split(";");
    const type = rawType?.trim().toLowerCase();
    if (type !== "text/html" && type !== "application/xhtml+xml") continue;
    const q = params
      .map((p) => /^\s*q=([0-9.]+)\s*$/i.exec(p))
      .find((m) => m !== null)?.[1];
    if (q !== undefined && Number(q) === 0) continue;
    return true;
  }
  return false;
}

/**
 * Is this a host on the machine or the local network?
 *
 * The gate on host derivation below. Deliberately a strict allowlist of the
 * shapes a demo laptop actually answers to, because it is standing in for a
 * security boundary: anything not matched here is treated as attacker-supplied.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|]$/g, ""); // IPv6 arrives bracketed
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if ([a, Number(v4[3]), Number(v4[4])].some((n) => n > 255) || b > 255) return false;
  return (
    a === 127 || // loopback
    a === 10 || // private
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 169 && b === 254) // link-local, which Windows hands out on a dead adapter
  );
}

/**
 * Where the human half lives, or null if we cannot say safely.
 *
 * `configured` wins when set: the deployed pair is two different domains and
 * nothing about a request could reveal the other one.
 *
 * Unset, the origin is derived from the host the request ARRIVED on, which is
 * the case that matters at a venue — a phone scans a code carrying a LAN
 * address, and deriving from that same address means the link works on whatever
 * IP the laptop holds today. An `APP_URL` pinned to a stale IP is a failure this
 * project has already been bitten by once.
 *
 * But `hostname` is the `Host` header (or `X-Forwarded-Host`, since the app
 * trusts one proxy hop), so it is CLIENT-CONTROLLED, and reflecting it into a
 * `Location` unguarded is an open redirect — verified against this route before
 * this guard existed: `X-Forwarded-Host: evil.example` moved the redirect to
 * `evil.example`. On a payments surface that is not a generic web nit. This
 * endpoint is what a QR code on a table points at, so the redirect lands
 * someone one hop from signing an authorization, and an attacker-chosen origin
 * can serve a convincing copy of the payer page.
 *
 * Hence: derive ONLY for a private or loopback host, which is exactly the case
 * derivation was added for. A public host must set `APP_URL`, and if it has not
 * we return null and the caller refuses to redirect rather than guessing.
 */
export function payerAppOrigin(
  configured: string | null,
  protocol: string,
  hostname: string,
  appPort: number,
): string | null {
  if (configured) return configured.replace(/\/+$/, "");
  if (!isPrivateHost(hostname)) return null;
  return `${protocol}://${hostname}:${appPort}`;
}

/**
 * The payer-app URL for a shop, carrying the amount when the link named one.
 *
 * The amount is passed through as the caller wrote it rather than reformatted:
 * it has already been validated as a positive SGD decimal, and the payer app
 * shows this string to someone about to sign for it, so "4.50" must not arrive
 * as "4.5".
 */
export function payerAppUrl(origin: string, handle: string, sgd: string | null): string {
  const url = `${origin}/pay/${encodeURIComponent(handle)}`;
  return sgd === null ? url : `${url}?sgd=${encodeURIComponent(sgd)}`;
}
