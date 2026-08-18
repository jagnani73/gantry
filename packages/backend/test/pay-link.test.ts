import { test } from "node:test";
import assert from "node:assert/strict";
import { payerAppOrigin, payerAppUrl, prefersHtml } from "../src/services/pay-link";

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

test("an unconfigured origin follows the host the request arrived on", () => {
  // The venue case: a phone scans a code carrying a LAN address, so the
  // redirect has to land on that same address rather than on whatever a stale
  // env var was pinned to when the laptop last had a different IP.
  assert.equal(payerAppOrigin(null, "http", "192.168.4.71", 3000), "http://192.168.4.71:3000");
  assert.equal(payerAppOrigin(null, "https", "demo.example", 443), "https://demo.example:443");
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
