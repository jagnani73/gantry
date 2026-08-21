import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROFILE_FIELDS,
  PROFILE_LIMITS,
  normalizeProfile,
  resolveProfile,
  toMerchantSummary,
  type IndexedMerchant,
  type MerchantProfile,
} from "../src/services/merchants-core";

/**
 * Pure-module tests (errors.test.ts precedent — the suite runs with no env, so
 * anything importing config/chain cannot be tested here).
 *
 * What this pins is the shop's public identity. These three strings are what a
 * payer sees on a receipt and on the merchant page, they hang off a handle that
 * is claimed on-chain and permanent, and the PATCH that writes them is
 * signed by the shop's payout address since 21 Aug — so "what is a legal name" has to be one answer,
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

test("a name made only of joiners is dropped on the READ path too", () => {
  // ZWJ and ZWNJ are deliberately permitted by the deception blocklist — they
  // are load-bearing inside emoji and Persian — so a name of fifty of them is
  // neither blank nor deceptive and trims to a non-empty string. It renders as
  // nothing, and `displayName ?? handle` does not fire on a present-but-invisible
  // value, so the shop would appear on the public directory with a blank name.
  // The write path has always refused this; the read path had to learn it when
  // merchant text moved on-chain behind a permissionless register.
  assert.deepEqual(
    resolveProfile({ displayName: "‍‍‍‍‍", location: "", blurb: "" }),
    {},
  );
  assert.equal(
    "location" in resolveProfile({ displayName: "", location: "‌ ‌", blurb: "" }),
    false,
  );
  // Still not a blocklist: a joiner doing its actual job survives.
  assert.equal(
    resolveProfile({ displayName: "Ah Hock \u{1F468}‍\u{1F373}", location: "", blurb: "" })
      .displayName,
    "Ah Hock \u{1F468}‍\u{1F373}",
  );
});

test("oversized on-chain text is dropped, not rendered or truncated", () => {
  // The contract bounds these in BYTES at 4x the client's codepoint limits, so
  // anything normalizeProfile accepts always fits. That arithmetic only holds
  // for text that came through a client: registerMerchant is permissionless, so
  // a shop registered straight on chain can store 240 codepoints of displayName
  // and the drawer, the sidebar and the laminated standee do not clamp.
  const overLong = "a".repeat(PROFILE_LIMITS.displayName + 1);
  assert.deepEqual(resolveProfile({ displayName: overLong, location: "", blurb: "" }), {});

  // Exactly at the ceiling still renders — an off-by-one here would silently
  // blank a legitimately-registered shop.
  const atLimit = "a".repeat(PROFILE_LIMITS.displayName);
  assert.equal(
    resolveProfile({ displayName: atLimit, location: "", blurb: "" }).displayName,
    atLimit,
  );

  // Per-field ceilings, applied by key. A copy-paste that checked displayName's
  // limit three times would pass a displayName-only test.
  for (const field of PROFILE_FIELDS) {
    const over = "b".repeat(PROFILE_LIMITS[field] + 1);
    const resolved = resolveProfile({ displayName: "", location: "", blurb: "", [field]: over });
    assert.equal(field in resolved, false, `${field} rendered over its ceiling`);
  }

  // Codepoints, not UTF-16 units: an astral emoji costs one, matching the write
  // path, or a name of emoji would be refused at half the stated limit.
  const emoji = "\u{1F35B}".repeat(PROFILE_LIMITS.displayName);
  assert.equal(
    resolveProfile({ displayName: emoji, location: "", blurb: "" }).displayName,
    emoji,
  );
});

test("a merchant with nothing on-chain gets no display fields at all", () => {
  // Absence is the contract: an unnamed merchant renders as its handle, which is
  // true, where an invented name is not. There is deliberately no seed-data
  // fallback any more — inventing a name for an empty record is exactly what
  // "the chain is the only source" forbids, and it would hide an unnamed shop.
  assert.deepEqual(resolveProfile({ displayName: "", location: "", blurb: "" }), {});
});

function indexed(overrides: Partial<IndexedMerchant> = {}): IndexedMerchant {
  return {
    merchant_id: "0x1f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0",
    handle: "ah-hock-chicken-rice",
    category_id: 1,
    display_name: "Ah Hock Chicken Rice",
    location: "Maxwell Food Centre #01-32",
    blurb: "Hainanese chicken rice since 1987.",
    block_number: 45_330_000,
    block_time: 1_785_900_500,
    ...overrides,
  };
}

test("a directory row carries no payout, and cannot be made to", () => {
  // The privacy rule is enforced by the schema — the store holds no such column —
  // so this pins the wire half of it. A shop's identity is public; the address
  // its money lands in is not something a public list of shops publishes.
  const row = toMerchantSummary(indexed());
  assert.equal("payout" in row, false);
  assert.deepEqual(Object.keys(row).sort(), [
    "blockNumber",
    "blurb",
    "categoryId",
    "categoryName",
    "displayName",
    "handle",
    "location",
    "merchantId",
    "registeredAt",
  ]);
});

test("a directory row is dated from its registration block", () => {
  const row = toMerchantSummary(indexed());
  assert.equal(row.registeredAt, 1_785_900_500);
  assert.equal(row.blockNumber, 45_330_000);
  // The registry's slug, matching MerchantResponse — the human label is a
  // client-side lookup, so the wire never has to be re-issued to reword one.
  assert.equal(row.categoryName, "food_beverage");
  // A keccak hash, so lowercase already IS canonical — running it through the
  // address checksummer would invent capitalisation that means nothing.
  // Compared against the INPUT, not against its own lowercasing, so this also
  // catches a mapper that substituted some other value.
  assert.equal(row.merchantId, indexed().merchant_id);
});

test("every listed row goes through the same read-path sanitiser", () => {
  // The directory renders text written by anyone who paid gas: registerMerchant
  // is permissionless and the contract checks length only. A row that skipped
  // resolveProfile would put an RLO override on a public page.
  const deceptive = toMerchantSummary(
    indexed({ display_name: "Ah Hock‮eciR nekcihC", location: "  ", blurb: "" }),
  );
  assert.equal("displayName" in deceptive, false);
  assert.equal("location" in deceptive, false);
  assert.equal("blurb" in deceptive, false);
  // The handle survives, which is what such a row renders as.
  assert.equal(deceptive.handle, "ah-hock-chicken-rice");
});

test("an unlisted category renders as its id, never as nothing", () => {
  // The chain accepts any uint16 < 256 and the directory lists whatever is
  // registered, so a category no client knows must still name itself.
  assert.equal(toMerchantSummary(indexed({ category_id: 250 })).categoryName, "category_250");
});
