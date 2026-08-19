import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isPrivateHost, payerAppOrigin, payerAppUrl, prefersHtml } from "../src/services/pay-link";

const WILDCARD = ["*", "/", "*"].join("");

test("a machine gets the payment challenge, not the page", () => {
  // The whole feature dies quietly if any of these redirects: curl and most
  // agent HTTP clients send a bare wildcard, and Express's own req.accepts()
  // resolves that to text/html.
  assert.equal(prefersHtml(undefined), false, "no Accept header at all");
  assert.equal(prefersHtml(""), false);
  assert.equal(prefersHtml(WILDCARD), false, "curl's default");
  assert.equal(prefersHtml("application/json"), false);
  assert.equal(prefersHtml(`application/json, ${WILDCARD};q=0.1`), false);
});

test("a browser gets the page", () => {
  assert.equal(
    prefersHtml(`text/html,application/xhtml+xml,application/xml;q=0.9,${WILDCARD};q=0.8`),
    true,
    "Chrome",
  );
  assert.equal(prefersHtml("text/html"), true);
  assert.equal(prefersHtml("TEXT/HTML"), true, "media types are case-insensitive");
  assert.equal(prefersHtml("  text/html ; charset=utf-8 "), true, "params and whitespace");
  assert.equal(prefersHtml("application/xhtml+xml"), true);
});

test("q=0 means the client refuses html, so it is not a browser", () => {
  // The only way a client can say "anything but this". Reading it as a request
  // for html would be exactly backwards.
  assert.equal(prefersHtml(`${WILDCARD}, text/html;q=0`), false);
  assert.equal(prefersHtml("text/html;q=0.0"), false);
  assert.equal(prefersHtml("text/html;q=0.1"), true, "a low preference is still a preference");
});

test("a configured app origin wins, trailing slashes and all", () => {
  assert.equal(
    payerAppOrigin("https://gantry-innovatex.vercel.app", "http", "gantry-backend.onrender.com", 3000),
    "https://gantry-innovatex.vercel.app",
  );
  assert.equal(payerAppOrigin("http://localhost:3000/", "http", "x", 3000), "http://localhost:3000");
  assert.equal(payerAppOrigin("http://localhost:3000///", "http", "x", 3000), "http://localhost:3000");
});

test("an unconfigured origin follows the host, but only on the local network", () => {
  // The venue case: a phone scans a code carrying a LAN address, so the
  // redirect has to land on that same address rather than on whatever a stale
  // env var was pinned to when the laptop last had a different IP.
  assert.equal(payerAppOrigin(null, "http", "192.168.4.71", 3000), "http://192.168.4.71:3000");
  assert.equal(payerAppOrigin(null, "http", "localhost", 3000), "http://localhost:3000");
  assert.equal(payerAppOrigin(null, "http", "10.91.207.201", 3000), "http://10.91.207.201:3000");
});

test("a client-supplied host is never reflected into a redirect", () => {
  // The Host header — and X-Forwarded-Host, which this app trusts one hop of —
  // is attacker-controlled. Reflecting it was a live open redirect on this exact
  // route: `X-Forwarded-Host: evil.example` moved the Location to evil.example,
  // one hop before a payer signs an authorization. Null here is the route
  // refusing to redirect at all.
  assert.equal(payerAppOrigin(null, "http", "evil.example", 3000), null);
  assert.equal(payerAppOrigin(null, "https", "gantry-backend.onrender.com", 3000), null);
  assert.equal(payerAppOrigin(null, "http", "192.168.4.71.evil.example", 3000), null, "suffix trick");
  assert.equal(payerAppOrigin(null, "http", "127.0.0.1.evil.example", 3000), null, "suffix trick");
  // A configured origin is ours, so the host is irrelevant to it.
  assert.equal(
    payerAppOrigin("https://gantry-innovatex.vercel.app", "http", "evil.example", 3000),
    "https://gantry-innovatex.vercel.app",
  );
});

test("isPrivateHost accepts the local shapes and nothing else", () => {
  for (const host of [
    "localhost",
    "LOCALHOST",
    "127.0.0.1",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.83.107", // what Windows hands out on a dead adapter
    "::1",
    "[::1]",
    "mac-mini.local",
  ]) {
    assert.equal(isPrivateHost(host), true, host);
  }
  for (const host of [
    "evil.example",
    "gantry-backend.onrender.com",
    "8.8.8.8",
    "172.15.0.1", // just below the private range
    "172.32.0.1", // just above it
    "192.169.1.1",
    "11.0.0.1",
    "999.999.999.999",
    "127.0.0.1.evil.example",
    "",
  ]) {
    assert.equal(isPrivateHost(host), false, host);
  }
});

test("the amount survives into the payer app exactly as written", () => {
  // "4.50" must not arrive as "4.5": this string is shown to someone about to
  // sign for it.
  assert.equal(
    payerAppUrl("http://localhost:3000", "ah-hock-chicken-rice", "4.50"),
    "http://localhost:3000/pay/ah-hock-chicken-rice?sgd=4.50",
  );
  assert.equal(
    payerAppUrl("http://localhost:3000", "ah-hock-chicken-rice", null),
    "http://localhost:3000/pay/ah-hock-chicken-rice",
  );
});

// ------------------------------------------------- the route's own call site

/**
 * `prefersHtml` is well covered above; the bug it exists for lives at the CALL
 * SITE. The naive implementation is `req.accepts("text/html")`, and Express
 * resolves a bare wildcard Accept — what curl and most agent HTTP clients send
 * — to text/html. Writing it that way hands an agent a redirect, closes the
 * machine door, and leaves every test in this file passing.
 *
 * Read off the source rather than mocked, because what is being pinned is which
 * function the route chose, and a mock would let the route call anything.
 */
test("GET /pay/:handle negotiates with prefersHtml, never req.accepts", () => {
  const route = readFileSync(new URL("../src/routes/order.ts", import.meta.url), "utf8");
  assert.match(route, /prefersHtml\(req\.headers\.accept\)/, "the route must use prefersHtml");
  assert.doesNotMatch(
    route,
    /req\.accepts\(/,
    "req.accepts resolves a bare wildcard to text/html, which closes the machine door",
  );
});

test("the pay link refuses rather than guessing when it cannot resolve an origin", () => {
  // payerAppOrigin fails CLOSED, and the route must carry that through as an
  // error instead of falling back to the request host — that fallback was a
  // live open redirect one hop before a payer signs an authorization.
  const route = readFileSync(new URL("../src/routes/order.ts", import.meta.url), "utf8");
  assert.match(route, /PayLinkNotConfigured/);
  assert.match(route, /res\.redirect\(302,/, "302, not 301 — the payer-app host is deploy state");
});
