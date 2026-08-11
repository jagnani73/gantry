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

/**
 * Codepoints that make a rendered string lie about itself.
 *
 * Written as numbers rather than a regex of escapes on purpose: the literal
 * characters are invisible in source, so a regex spelling them out cannot be
 * reviewed, diffed, or safely edited — and an escape that loses a backslash in
 * transit degrades silently from "control characters" to a few literal letters,
 * which still compiles and still passes a careless test.
 *
 * Zero-width JOINER (0x200D) and NON-JOINER (0x200C) are deliberately absent:
 * they are load-bearing inside emoji sequences and in Persian text, and neither
 * can disguise one shop as another.
 */
const DECEPTIVE_CODEPOINTS = new Set([
  0x200b, // zero-width space — pads a name past what a reader can see
  0x200e, // left-to-right mark
  0x200f, // right-to-left mark
  0x2028, // line separator
  0x2029, // paragraph separator
  0xfeff, // zero-width no-break space
]);

/** Bidi overrides and isolates: RLO renders "cable" as "elbac". */
const DECEPTIVE_RANGES: readonly (readonly [number, number])[] = [
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

/**
 * A control code would break the one-line blurb and smuggle a second line onto
 * a receipt, so C0 and C1 are rejected wholesale.
 */
function isControl(codePoint: number): boolean {
  return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
}

export function isDeceptive(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (isControl(codePoint) || DECEPTIVE_CODEPOINTS.has(codePoint)) return true;
    if (DECEPTIVE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high)) return true;
  }
  return false;
}

/** The joiners we deliberately allow — legal INSIDE a name, but not a name. */
const ZERO_WIDTH_JOINERS = new Set([0x200c, 0x200d]);

/**
 * Does this render as anything at all?
 *
 * The blocklist above intentionally permits ZWJ and ZWNJ because they are
 * load-bearing inside emoji sequences and Persian text, and neither can
 * disguise one shop as another. They CAN disguise a shop as blank: a name of
 * fifty joiners trims to nothing visible, passes every length and deception
 * check, and becomes an invisible shop name on every receipt and merchant page
 * — hanging off a handle that is claimed on-chain and permanent. That is the
 * same failure the zero-width SPACE is rejected for, so it needs the same
 * answer, expressed as a requirement rather than a longer blocklist.
 *
 * EXPORTED because the read path needs it too. While `normalizeProfile` was the
 * only writer this could stay private, but merchant text went on-chain and
 * `registerMerchant` is permissionless, so a name of fifty joiners can be
 * written straight to the contract without ever passing through here. The read
 * path (`resolveProfile`) is the only chokepoint left, and it has to apply the
 * same three rules this one does: non-blank, not deceptive, and visible.
 */
export function hasVisibleContent(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (ZERO_WIDTH_JOINERS.has(codePoint)) continue;
    if (/\s/u.test(character)) continue;
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
