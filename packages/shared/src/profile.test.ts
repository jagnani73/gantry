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

test("a name made only of joiners is refused — it renders as nothing", () => {
  // ZWJ is legal INSIDE a name and must stay legal, but a name that is entirely
  // joiners trims to nothing visible and would become an invisible shop on every
  // receipt, hanging off a permanently claimed handle.
  for (const field of ["displayName", "location", "blurb"] as const) {
    const result = normalizeProfile({ ...ok, [field]: ZWJ.repeat(20) });
    assert.equal(result.ok, false, `${field} accepted an all-joiner value`);
    assert.equal(result.ok === false && result.field, field);
  }
  assert.equal(normalizeProfile({ ...ok, displayName: `${ZWJ} ${ZWNJ}` }).ok, false);
});

test("invisible format characters beyond the old blocklist are refused", () => {
  // The list these replaced named six codepoints and two ranges. Each of these
  // is invisible and none of them was on it, so each rendered as a blank shop
  // name on every payer surface with the displayName-??-handle fallback never
  // firing, because the key was present.
  const invisible = {
    "U+2060 word joiner": 0x2060,
    "U+00AD soft hyphen": 0x00ad,
    "U+2061 function application": 0x2061,
    "U+180E mongolian vowel separator": 0x180e,
    "U+E0041 tag latin a": 0xe0041,
  };
  for (const [name, codePoint] of Object.entries(invisible)) {
    const char = String.fromCodePoint(codePoint);
    assert.ok(isDeceptive(char), `${name} passed isDeceptive`);
    assert.equal(normalizeProfile({ ...ok, displayName: char.repeat(8) }).ok, false, name);
  }
});

test("invisible characters Unicode calls LETTERS are refused too", () => {
  // The category-based rule cannot reach these: the Hangul fillers are Lo
  // (Letter, other) and the braille blank is So, so \p{C} does not match them
  // and they are not deceptive by category — they are simply blank. This is the
  // standard blank-username trick and it has to be named explicitly.
  for (const codePoint of [0x115f, 0x1160, 0x3164, 0xffa0, 0x2800]) {
    const char = String.fromCodePoint(codePoint);
    const result = normalizeProfile({ ...ok, displayName: char.repeat(8) });
    assert.equal(result.ok, false, `U+${codePoint.toString(16)} accepted as a shop name`);
    assert.equal(result.ok === false && result.field, "displayName");
  }
});

test("combining marks alone are not a name, but accented text still is", () => {
  const CGJ = String.fromCodePoint(0x034f); // combining grapheme joiner: Mn, no width
  const ACUTE = String.fromCodePoint(0x0301);
  assert.equal(normalizeProfile({ ...ok, displayName: CGJ.repeat(10) }).ok, false);
  // The base letters supply the ink and the mark rides along — decomposed
  // "José" must keep working, or the rule has eaten real names to catch a trick.
  assert.equal(normalizeProfile({ ...ok, displayName: `Jose${ACUTE} Cafe` }).ok, true);
});

test("emoji sequences survive the visibility rule", () => {
  // ZWJ is \p{Cf} and is skipped as ink, so a sequence only passes because the
  // emoji themselves are visible. If this breaks, the rule has become a
  // blocklist on joiners rather than a requirement for ink.
  const FAMILY = `${String.fromCodePoint(0x1f468)}${ZWJ}${String.fromCodePoint(0x1f469)}`;
  assert.equal(normalizeProfile({ ...ok, displayName: FAMILY }).ok, true);
  assert.equal(normalizeProfile({ ...ok, displayName: `${BOWL} Kopi` }).ok, true);
});

test("every field's ceiling is enforced, not just the first", () => {
  // The limits differ per field and the loop applies them by key; a copy-paste
  // that checked displayName's ceiling three times would pass a displayName-only
  // test.
  for (const field of ["displayName", "location", "blurb"] as const) {
    const atLimit = "a".repeat(PROFILE_LIMITS[field]);
    assert.equal(normalizeProfile({ ...ok, [field]: atLimit }).ok, true, `${field} rejected at limit`);
    const over = "a".repeat(PROFILE_LIMITS[field] + 1);
    const result = normalizeProfile({ ...ok, [field]: over });
    assert.equal(result.ok, false, `${field} accepted one over its limit`);
    assert.equal(result.ok === false && result.field, field);
  }
});

test("profileFieldLength agrees with the limit on astral input", () => {
  assert.equal(profileFieldLength("  ab  "), 2);
  assert.equal(profileFieldLength(BOWL.repeat(2)), 2);
});
