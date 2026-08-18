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
 * Where the human half lives.
 *
 * `configured` wins when set (the deployed pair is two different domains, and
 * nothing about the request could tell us the other one). Otherwise the origin
 * is derived from the host the request ARRIVED on, which is the case that
 * matters at a venue: a phone scans a code carrying a LAN address, and deriving
 * the redirect from that same address means the link works on whatever IP the
 * laptop happens to hold. An `APP_URL` pinned to a stale IP is precisely the
 * failure this project has already been bitten by once.
 */
export function payerAppOrigin(
  configured: string | null,
  protocol: string,
  hostname: string,
  appPort: number,
): string {
  if (configured) return configured.replace(/\/+$/, "");
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
