import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeceptive, normalizeProfile, profileFieldLength, PROFILE_LIMITS } from "./profile";

/**
 * Characters under test are built from codepoints, never pasted: a literal
 * zero-width space in a test file is invisible to every reviewer and turns the
 * file binary to grep, so the one place these rules are checked would be the one
 * place nobody can read.
 */
const ZWSP = String.fromCodePoint(0x200b);
const ZWJ = String.fromCodePoint(0x200d);
const ZWNJ = String.fromCodePoint(0x200c);
const RLO = String.fromCodePoint(0x202e);
const LRI = String.fromCodePoint(0x2066);
const BOWL = String.fromCodePoint(0x1f35b); // an astral emoji: 2 UTF-16 units, 1 codepoint

const ok = {
  displayName: "Ah Hock Chicken Rice",
  location: "Maxwell Food Centre",
  blurb: "Since 1987.",
};

test("normalizeProfile trims and accepts a plain record", () => {
  const result = normalizeProfile({ ...ok, displayName: "  Ah Hock Chicken Rice  " });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.displayName, "Ah Hock Chicken Rice");
});

test("blank after trimming is rejected, not stored as empty", () => {
  const result = normalizeProfile({ ...ok, location: "   " });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.field, "location");
});

test("limits count codepoints, so an emoji costs one not two", () => {
  const atLimit = BOWL.repeat(PROFILE_LIMITS.displayName);
  // UTF-16 length is double the ceiling; a String.length check would reject this.
  assert.ok(atLimit.length > PROFILE_LIMITS.displayName);
  assert.equal(normalizeProfile({ ...ok, displayName: atLimit }).ok, true);

  const overLimit = BOWL.repeat(PROFILE_LIMITS.displayName + 1);
  assert.equal(normalizeProfile({ ...ok, displayName: overLimit }).ok, false);
});

test("control characters are refused rather than silently flattened", () => {
  // A newline in a blurb smuggles a second line onto a receipt.
  assert.equal(normalizeProfile({ ...ok, blurb: "Line one\nLine two" }).ok, false);
  assert.ok(isDeceptive("ab"));
  assert.ok(isDeceptive(`a${String.fromCodePoint(0x85)}b`)); // C1 range
});

test("bidi overrides and isolates are refused", () => {
  // RLO renders "cable" as "elbac" — a shop could display a name it does not have.
  assert.ok(isDeceptive(`${RLO}cable`));
  assert.ok(isDeceptive(`${LRI}x`));
  assert.equal(normalizeProfile({ ...ok, displayName: `Gadget${RLO}Hub` }).ok, false);
});

test("zero-width joiner and non-joiner stay legal", () => {
  // Load-bearing in emoji sequences and Persian text, and neither can disguise
  // one shop as another — so rejecting them would break real names.
  assert.equal(isDeceptive(ZWJ), false);
  assert.equal(isDeceptive(ZWNJ), false);
  assert.equal(normalizeProfile({ ...ok, displayName: `Kopi${ZWJ}Corner` }).ok, true);
});

test("zero-width space is refused because it pads a name invisibly", () => {
  assert.ok(isDeceptive(`Ah${ZWSP}Hock`));
});

test("profileFieldLength agrees with the limit on astral input", () => {
  assert.equal(profileFieldLength("  ab  "), 2);
  assert.equal(profileFieldLength(BOWL.repeat(2)), 2);
});
