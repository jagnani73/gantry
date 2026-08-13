import { test } from "node:test";
import assert from "node:assert/strict";
import { BaseError, HttpRequestError } from "viem";
import { redactSecrets, registerSecrets, safeMessage } from "../src/redact";

/**
 * Pure-module tests (errors.test.ts precedent): redact.ts imports only node:util
 * and viem — no config, no chain. That is load-bearing, not incidental:
 * errors.ts depends on this module, and config.ts calls process.exit(1) without
 * an RPC URL, which would take the whole suite down in CI.
 *
 * What this pins is that the RPC credential cannot reach a caller. The key is in
 * the URL PATH of an Alchemy endpoint, so the URL is the secret, and viem puts
 * it in `BaseError.message` via metaMessages while leaving `shortMessage` clean.
 */

const RPC = "https://base-sepolia.g.alchemy.com/v2/AAAABBBBCCCCDDDDEEEEFFFF11112222";
const KEY = "AAAABBBBCCCCDDDDEEEEFFFF11112222";

test("with nothing registered, redactSecrets is the identity function", () => {
  // Every unit test in this repo runs in that state; safeMessage must still work.
  assert.equal(redactSecrets(`fetch failed for ${RPC}`), `fetch failed for ${RPC}`);
});

test("a registered url is redacted, and so is its bare key on its own", () => {
  registerSecrets([RPC, RPC.replace("https://", "wss://")]);

  assert.equal(redactSecrets(`URL: ${RPC}`), "URL: [redacted]");
  // A key can outlive the URL it came from — a different scheme, a trailing
  // query, a provider echoing the credential back by itself.
  assert.equal(redactSecrets(`apiKey=${KEY}`), "apiKey=[redacted]");
  assert.equal(
    redactSecrets(`ws ${RPC.replace("https://", "wss://")} down`),
    "ws [redacted] down",
  );
});

test("host-ish path segments are not blanket-redacted", () => {
  registerSecrets(["https://sepolia.base.org"]);
  // "sepolia.base.org" is under the 16-char floor as a *segment*, and the public
  // node has no credential to protect — redacting it would make logs unreadable
  // for the node that carries the correctness path.
  assert.equal(redactSecrets("chunk served by sepolia.base.org"), "chunk served by sepolia.base.org");
});

test("safeMessage drops viem metaMessages, which is where the url lives", () => {
  registerSecrets([RPC]);

  const err = new BaseError("HTTP request failed.", {
    metaMessages: [`URL: ${RPC}`, "Request body: {}"],
  });

  // The bug this guards: err.message is shortMessage PLUS metaMessages.
  assert.ok(err.message.includes(KEY), "precondition: viem does embed the url in .message");
  assert.equal(safeMessage(err), "HTTP request failed.");
  assert.ok(!safeMessage(err).includes(KEY));
});

test("safeMessage also covers a real HttpRequestError", () => {
  registerSecrets([RPC]);

  const err = new HttpRequestError({ url: RPC, status: 500, details: "boom" });

  assert.ok(!safeMessage(err).includes(KEY), safeMessage(err));
});

test("safeMessage redacts a plain Error that carries the url in its text", () => {
  registerSecrets([RPC]);

  // Not a BaseError, so shortMessage does not apply — the redaction pass behind
  // it is what covers anything that rethrows a viem message as a plain Error.
  const err = new Error(`relayer broadcast failed against ${RPC}`);

  assert.equal(safeMessage(err), "relayer broadcast failed against [redacted]");
});

test("safeMessage handles non-Error throws", () => {
  registerSecrets([RPC]);

  assert.equal(safeMessage("just a string"), "just a string");
  assert.equal(safeMessage(RPC), "[redacted]");
  assert.equal(safeMessage(undefined), "undefined");
});
