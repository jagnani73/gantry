/**
 * Merchant display-profile rules, shared so the form and the API cannot disagree.
 *
 * These lived in the backend first. They are here because the onboarding form
 * and the shop-profile editor both validate the same three fields, and a form
 * that merely knows the *numbers* still drifts on the *rules* — it would accept
 * a right-to-left override the API rejects, and surface that as a mystery 400
 * after the merchant has already typed a permanent handle.
 */

/** The off-chain display record. The chain stores handle/payout/category only. */
export interface MerchantProfile {
  displayName: string;
  location: string;
  blurb: string;
}

/**
 * Ceilings in CODEPOINTS, not UTF-16 units: an emoji in a shop name costs two
 * units and would otherwise silently halve the budget. Sized to the design's
 * fields — a name on a receipt line, a location under it, and a blurb the
 * merchant page renders as ONE line.
 */
export const PROFILE_LIMITS = {
  displayName: 60,
  location: 80,
  blurb: 140,
} as const;

export type ProfileField = keyof typeof PROFILE_LIMITS;

/** Checked in the form's visual order, so the first complaint is the topmost field. */
export const PROFILE_FIELDS: readonly ProfileField[] = ["displayName", "location", "blurb"];

export type ProfileResult =
  | { ok: true; value: MerchantProfile }
  | { ok: false; field: ProfileField; message: string };

/** The joiners we deliberately allow — legal INSIDE a name, but not a name. */
const ZERO_WIDTH_JOINERS = new Set([0x200c, 0x200d]);

/**
 * Characters that make a rendered string lie about itself.
 *
 * This is a REQUIREMENT expressed against Unicode's own categories, not a list
 * of codepoints, and that is the whole point. The list it replaced enumerated
 * six codepoints and two ranges, which is exactly as complete as whoever wrote
 * it thought to be: U+2060 WORD JOINER, U+00AD SOFT HYPHEN, U+2061..U+2064 and
 * the U+E0000 tag block all sailed through it, each of them invisible, none of
 * them on the list. Naming a property closes the class; naming members closes
 * only the members.
 *
 * `\p{C}` is Cc, Cf, Co, Cs and Cn — controls, format characters, private use,
 * surrogates, unassigned. Every previously-listed codepoint is inside it
 * (U+200B, U+200E/F and U+FEFF are Cf; the bidi overrides and isolates are Cf;
 * C0 and C1 are Cc), so nothing is lost. `\p{Zl}`/`\p{Zp}` add U+2028/U+2029,
 * which are Z rather than C and would otherwise smuggle a second line onto a
 * receipt.
 *
 * Zero-width JOINER and NON-JOINER are the deliberate exception: they are
 * load-bearing inside emoji sequences and Persian text, and neither can
 * disguise one shop as another. They CAN disguise a shop as blank, which is
 * `hasVisibleContent`'s job below, not this one's.
 */
export function isDeceptive(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (ZERO_WIDTH_JOINERS.has(codePoint)) continue;
    if (/[\p{C}\p{Zl}\p{Zp}]/u.test(character)) return true;
  }
  return false;
}

/**
 * Invisible characters that are NOT `\p{C}`, so `isDeceptive` cannot catch them.
 *
 * Unicode classifies the Hangul fillers as `Lo` — Letter, other. They are
 * letters as far as every category-based rule is concerned, and they render as
 * blank, which is what makes them the standard blank-username trick. No
 * property escape excludes them; they have to be named. U+2800 is `So` and
 * renders as an empty braille cell for the same effect.
 */
const BLANK_LETTERS = new Set([
  0x115f, // hangul choseong filler
  0x1160, // hangul jungseong filler
  0x3164, // hangul filler
  0xffa0, // halfwidth hangul filler
  0x2800, // braille pattern blank
]);

/**
 * Does this render as anything at all?
 *
 * A name of fifty joiners trims to nothing visible, passes every length and
 * deception check, and becomes an invisible shop name on every receipt and
 * merchant page — hanging off a handle that is claimed on-chain and permanent.
 * Because the key is then *present*, the `displayName ?? handle` fallback that
 * every render site relies on never fires, and a payer's confirm screen reads
 * "Paid to " with nothing after it.
 *
 * Stated as a requirement — at least one character that paints ink — rather
 * than as a longer blocklist. `\p{C}` and `\p{Z}` cover the format characters
 * and the spaces; `\p{M}` covers combining marks, which have no width of their
 * own and need a base character to attach to (U+034F COMBINING GRAPHEME JOINER
 * is the one that gets used deliberately). Legitimate accented text is
 * unaffected: in "José" the base letters supply the ink and the mark rides
 * along.
 *
 * EXPORTED because the read path needs it too. While `normalizeProfile` was the
 * only writer this could stay private, but merchant text went on-chain and
 * `registerMerchant` is permissionless, so a name of fifty joiners can be
 * written straight to the contract without ever passing through here. The read
 * path (`resolveProfile`) is the only chokepoint left, and it has to apply the
 * same rules this one does: non-blank, not deceptive, and visible.
 */
export function hasVisibleContent(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (BLANK_LETTERS.has(codePoint)) continue;
    if (/[\p{C}\p{Z}\p{M}]/u.test(character)) continue;
    return true;
  }
  return false;
}

/**
 * Trim, then reject rather than repair. These fields are a shop's public
 * identity on every receipt and merchant page, and the handle they hang off is
 * claimed on-chain and permanent — so a name that arrives wrong should come back
 * as an error the merchant can see and fix, not as something quietly truncated
 * to 60 characters while they watch.
 */
export function normalizeProfile(input: MerchantProfile): ProfileResult {
  const value = {} as MerchantProfile;
  for (const field of PROFILE_FIELDS) {
    const trimmed = input[field].trim();
    if (trimmed.length === 0) {
      return { ok: false, field, message: `${field} must not be blank` };
    }
    const codepoints = [...trimmed].length;
    if (codepoints > PROFILE_LIMITS[field]) {
      return {
        ok: false,
        field,
        message: `${field} must be at most ${PROFILE_LIMITS[field]} characters (got ${codepoints})`,
      };
    }
    if (isDeceptive(trimmed)) {
      return {
        ok: false,
        field,
        message: `${field} must be a single line of plain text: no line breaks, invisible or direction-override characters`,
      };
    }
    if (!hasVisibleContent(trimmed)) {
      return { ok: false, field, message: `${field} must contain visible characters` };
    }
    value[field] = trimmed;
  }
  return { ok: true, value };
}

/**
 * Codepoint length, for a live character counter under a field. `String.length`
 * counts UTF-16 units, so it disagrees with the limit above on exactly the
 * inputs a counter exists to warn about.
 */
export function profileFieldLength(value: string): number {
  return [...value.trim()].length;
}
