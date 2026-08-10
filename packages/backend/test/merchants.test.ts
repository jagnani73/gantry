import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROFILE_LIMITS,
  normalizeProfile,
  resolveProfile,
  type MerchantProfile,
} from "../src/services/merchants-core";

/**
 * Pure-module tests (errors.test.ts precedent — the suite runs with no env, so
 * anything importing config/chain cannot be tested here).
 *
 * What this pins is the shop's public identity. These three strings are what a
 * payer sees on a receipt and on the merchant page, they hang off a handle that
 * is claimed on-chain and permanent, and the PATCH that writes them is
 * unauthenticated by decision — so "what is a legal name" has to be one answer,
 * checked here rather than re-derived per surface.
 */

function profile(overrides: Partial<MerchantProfile> = {}): MerchantProfile {
  return {
    displayName: "Ah Hock Chicken Rice",
    location: "Maxwell Food Centre",
    blurb: "Hainanese chicken rice, kopi and iced tea since 1987.",
    ...overrides,
  };
}

/** Narrows to the failure arm and hands back the field that was rejected. */
function rejection(input: MerchantProfile): { field: string; message: string } {
  const result = normalizeProfile(input);
  assert.equal(result.ok, false, "expected this profile to be rejected");
  assert.ok(!result.ok);
  return { field: result.field, message: result.message };
}

test("a valid profile comes back trimmed, with interior spacing untouched", () => {
  const result = normalizeProfile(profile({ displayName: "  Ah Hock  Chicken Rice  " }));
  assert.ok(result.ok);
  assert.equal(result.value.displayName, "Ah Hock  Chicken Rice");
  assert.equal(result.value.location, "Maxwell Food Centre");
});

test("blank and whitespace-only fields are rejected, naming the field", () => {
  assert.equal(rejection(profile({ displayName: "" })).field, "displayName");
  assert.equal(rejection(profile({ location: "   " })).field, "location");
  assert.equal(rejection(profile({ blurb: "\t" })).field, "blurb");
});

test("the topmost bad field is the one reported", () => {
  // The form renders name → location → blurb; complaining about the last one
  // while the first is also empty sends the merchant to the wrong input.
  assert.equal(rejection(profile({ displayName: "", location: "", blurb: "" })).field, "displayName");
});

test("the length ceiling is inclusive, and one over is refused not truncated", () => {
  const atLimit = "a".repeat(PROFILE_LIMITS.displayName);
  const over = "a".repeat(PROFILE_LIMITS.displayName + 1);

  const ok = normalizeProfile(profile({ displayName: atLimit }));
  assert.ok(ok.ok);
  assert.equal(ok.value.displayName, atLimit);

  const bad = rejection(profile({ displayName: over }));
  assert.equal(bad.field, "displayName");
  assert.match(bad.message, /at most 60 characters/);
});

test("length is counted in codepoints, not UTF-16 units", () => {
  // Every one of these is two UTF-16 units; counting units would refuse a name
  // that is visibly half the allowed length.
  const emoji = "\u{1F35C}".repeat(PROFILE_LIMITS.displayName);
  const result = normalizeProfile(profile({ displayName: emoji }));
  assert.ok(result.ok, "an emoji name at the codepoint limit must be accepted");
});

test("a newline is refused — the blurb is rendered as one line", () => {
  const bad = rejection(profile({ blurb: "Chicken rice.\nAlso kopi." }));
  assert.equal(bad.field, "blurb");
  assert.match(bad.message, /single line/);
});

test("bidi overrides and invisible padding are refused", () => {
  // U+202E reverses everything after it, so a shop could render as another one;
  // U+200B pads a name past what a reader can see.
  assert.equal(rejection(profile({ displayName: "Ah Hock\u202EeciR nekcihC" })).field, "displayName");
  assert.equal(rejection(profile({ location: "Maxwell\u200B\u200BFood Centre" })).field, "location");
});

test("ZWJ emoji sequences survive — the filter targets deception, not glyphs", () => {
  const result = normalizeProfile(profile({ displayName: "Ah Hock \u{1F468}\u200D\u{1F373}" }));
  assert.ok(result.ok);
});

test("the chain's text is the profile, whole", () => {
  const resolved = resolveProfile({
    displayName: "Ah Hock Chicken Rice (Stall 32)",
    location: "Maxwell Food Centre #01-32",
    blurb: "Hainanese chicken rice since 1987.",
  });
  assert.equal(resolved.displayName, "Ah Hock Chicken Rice (Stall 32)");
  assert.equal(resolved.location, "Maxwell Food Centre #01-32");
  assert.equal(resolved.blurb, "Hainanese chicken rice since 1987.");
});

test("an empty field is ABSENT, not an empty string", () => {
  // `""` is what the contract stores for a field nobody set, and the two must not
  // be conflated: JSON.stringify keeps `undefined` out either way, but
  // `"blurb" in row` is how a caller asks whether a shop has written one.
  const resolved = resolveProfile({ displayName: "Ah Hock", location: "", blurb: "" });
  assert.equal(resolved.displayName, "Ah Hock");
  assert.equal("location" in resolved, false);
  assert.equal("blurb" in resolved, false);
});

test("text that lies about itself is dropped, not forwarded", () => {
  // The chokepoint MOVED here when the record went on-chain. registerMerchant is
  // permissionless and the contract checks length only, so these reach the read
  // path without ever passing normalizeProfile — and the honest rendering of a
  // name designed to deceive is the shop's own handle.
  assert.deepEqual(
    resolveProfile({ displayName: "Ah Hock\u202EeciR nekcihC", location: "", blurb: "" }),
    {},
  );
  assert.equal(
    "location" in resolveProfile({ displayName: "", location: "Maxwell\u200B\u200BFood", blurb: "" }),
    false,
  );
  // Whitespace is the quiet one: legal on-chain, TRUTHY, and forwarded raw it
  // renders as a blank name while the handle fallback never fires.
  assert.deepEqual(resolveProfile({ displayName: "   ", location: "\t", blurb: "" }), {});
  // Trimmed, not rejected, when the interior is fine.
  assert.equal(
    resolveProfile({ displayName: "  Ah Hock  ", location: "", blurb: "" }).displayName,
    "Ah Hock",
  );
  // Emoji are not deception — the filter targets intent, not glyphs.
  assert.equal(
    resolveProfile({ displayName: "Ah Hock \u{1F468}\u200D\u{1F373}", location: "", blurb: "" })
      .displayName,
    "Ah Hock \u{1F468}\u200D\u{1F373}",
  );
});

test("a merchant with nothing on-chain gets no display fields at all", () => {
  // Absence is the contract: an unnamed merchant renders as its handle, which is
  // true, where an invented name is not. There is deliberately no seed-data
  // fallback any more — inventing a name for an empty record is exactly what
  // "the chain is the only source" forbids, and it would hide an unnamed shop.
  assert.deepEqual(resolveProfile({ displayName: "", location: "", blurb: "" }), {});
});
