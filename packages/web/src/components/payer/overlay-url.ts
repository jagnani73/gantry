import { isAddress, type Address } from "viem";
import { isKnownCategory, isValidHandle } from "@gantry/shared";
// The payer's OWN rule for what an amount looks like, imported rather than
// restated. `?sgd=` prefills the very keypad this predicate gates, so a second
// regex here would be free to accept a string the pad then silently blanks.
import { isAmountShape } from "./amount-keypad";
// TYPE-only, and deliberately so: erased at compile time, it leaves this module
// with no runtime dependency on the provider at all. The provider imports these
// functions, so a value import would be a real cycle; a type import is not one,
// and it keeps the serializer a pure module anything can read or test.
import type { Overlay } from "./payer-context";

/**
 * The payer app's overlays, written as a query string and read back again.
 *
 * Overlays used to be invisible to the URL: a payment half-filled on
 * `/pay/ah-hock-chicken-rice` could not be refreshed, no receipt could be
 * linked, and Back left the app entirely rather than closing what was on top of
 * it. Worse, closing an overlay on `/pay/:handle` popped the stack and left the
 * URL still naming a payment — so the address bar was stating something the
 * screen had stopped showing, and a refresh dropped the payer back into it.
 *
 * The vocabulary is short and readable on purpose — these are URLs a merchant
 * prints, a presenter reads aloud and a judge types:
 *
 *   ?scan=1                    the camera
 *   ?pay=<handle>[&sgd=<amt>]  the amount pad for a shop
 *   ?receipt=<row key>         one payment or one refusal
 *   ?shop=<handle>             a shop's page
 *   ?agent=<address>           an agent wallet's detail screen
 *   ?edit=<address>|new        the agent form  [&allow=<categoryId>]
 *
 * EVERYTHING HERE IS VALIDATED ON READ. A query string is the one input a
 * stranger can hand a payer fully-formed, and three of these values end up
 * rendered as facts — a shop's name, a wallet the payer is about to sign for, a
 * price. Anything that fails its check yields `null` and the overlay simply does
 * not open; nothing junk is ever rendered as a price, a shop or an address.
 */

/**
 * Every param this module may write.
 *
 * The provider clears all of them before writing a new overlay's query, which is
 * what stops a `pay` left over from the previous overlay sitting beside the
 * `receipt` that replaced it and making one URL name two overlays. Clearing a
 * fixed LIST rather than the whole search string is also what lets a param that
 * is not ours survive an overlay opening and closing.
 */
export const OVERLAY_PARAMS = [
  "scan",
  "pay",
  "sgd",
  "shop",
  "agent",
  "edit",
  "allow",
  "receipt",
] as const;

/**
 * `?edit=new` — the agent form with no wallet behind it.
 *
 * A sentinel rather than an absent value, because `?edit=` with nothing after it
 * is exactly what a truncated copy-paste produces, and that must not resolve to
 * "create a new agent": creating one is an on-chain deploy that can never be
 * undone, and a second wallet for one session key is the specific mistake this
 * app already works hard to avoid.
 */
const NEW_AGENT = "new";

/**
 * Longest receipt key we will read out of a URL.
 *
 * `settlementKey` is `0x<64 hex>:<log index>` and `denialKey` is
 * `denial:0x<64 hex>`, so 96 is generous. This is deliberately a BOUND and not
 * the exact grammar: the key is only ever compared against keys this app minted
 * itself, so a wrong one finds nothing and lands on the "not in this wallet's
 * history" screen, which is the honest answer either way — while restating the
 * grammar would be a second copy of `settlementKey`/`denialKey`, free to drift
 * from the first. What the bound stops is the other thing: an unbounded string
 * off a URL being echoed onto the screen that reports the miss.
 */
const RECEIPT_KEY_MAX = 96;
const RECEIPT_KEY_SHAPE = /^[A-Za-z0-9:_.-]+$/;

/**
 * An overlay's query.
 *
 * Never null, and that is the invariant this file exists to hold: every overlay
 * must be addressable, so a new member of the union has to be given a spelling
 * here before it will compile. An overlay with no URL form would open, write
 * nothing, and then be closed by the first Back — which is the bug this whole
 * change is about.
 */
export function overlayToQuery(overlay: Overlay): URLSearchParams {
  switch (overlay.kind) {
    case "scan":
      return new URLSearchParams({ scan: "1" });
    case "pay": {
      const params = new URLSearchParams({ pay: overlay.handle });
      // The same spelling the printed-QR route and the merchant's charge link
      // already use, so `/pay/x?sgd=1.50` and `/app?pay=x&sgd=1.50` mean one
      // thing and a payer can move an amount between them by hand.
      if (overlay.amount !== undefined) params.set("sgd", overlay.amount);
      return params;
    }
    case "receipt":
      return receiptQuery(overlay.row.key);
    case "merchant":
      return new URLSearchParams({ shop: overlay.handle });
    case "agent":
      return new URLSearchParams({ agent: overlay.wallet });
    case "agentForm": {
      const params = new URLSearchParams({ edit: overlay.wallet ?? NEW_AGENT });
      if (overlay.addCategory !== undefined) params.set("allow", String(overlay.addCategory));
      return params;
    }
  }
}

/**
 * The receipt case of `overlayToQuery`, reachable with a bare KEY.
 *
 * A receipt restored from a cold URL has no row yet — the history has not
 * loaded — so the provider holds the key alone and still has to be able to say
 * what the URL currently means. Sharing this one function with `overlayToQuery`
 * is what makes the two agree: if a pending receipt and a resolved one spelled
 * themselves differently, the provider's write-back guard would see a mismatch
 * the instant the row landed and rewrite the URL with itself, on every render,
 * forever.
 */
export function receiptQuery(key: string): URLSearchParams {
  return new URLSearchParams({ receipt: key });
}

/**
 * What a URL asks for — which is not always an overlay yet.
 *
 * A receipt is the one overlay that carries a whole object rather than an id, so
 * its URL form is the row's key and resolving it means finding that row in a
 * history the app may not have fetched. Handing the caller a KEY rather than a
 * half-built overlay is what keeps "still loading" and "not in this wallet's
 * history" two different answers instead of one silent close.
 */
export type PendingOverlay =
  | { kind: "resolved"; overlay: Overlay }
  | { kind: "receipt"; key: string };

/**
 * The overlay a query string names, or null for none.
 *
 * Params are read in the order the `Overlay` union declares them and the FIRST
 * match wins, so a hand-edited URL naming two overlays resolves the same way
 * every time. One place to look for that order, and it is the union itself.
 */
export function overlayFromQuery(params: URLSearchParams): PendingOverlay | null {
  // Exactly the value we write. Presence alone would open the camera for
  // `?scan=0`, which is the one reading of that URL nobody means.
  if (params.get("scan") === "1") return { kind: "resolved", overlay: { kind: "scan" } };

  const payHandle = handleParam(params.get("pay"));
  if (payHandle !== null) {
    const amount = amountParam(params.get("sgd"));
    return {
      kind: "resolved",
      // Spread rather than `amount: undefined`, so an overlay built from a URL
      // is deep-equal to one built by a button. The provider compares the two
      // through their serialized form, but a caller that compares the objects
      // should not be tripped by a key that exists holding nothing.
      overlay: { kind: "pay", handle: payHandle, ...(amount === undefined ? {} : { amount }) },
    };
  }

  const receipt = receiptKeyParam(params.get("receipt"));
  if (receipt !== null) return { kind: "receipt", key: receipt };

  const shop = handleParam(params.get("shop"));
  if (shop !== null) return { kind: "resolved", overlay: { kind: "merchant", handle: shop } };

  const agent = addressParam(params.get("agent"));
  if (agent !== null) return { kind: "resolved", overlay: { kind: "agent", wallet: agent } };

  const edit = params.get("edit");
  if (edit !== null) {
    const isNew = edit.trim() === NEW_AGENT;
    const wallet = isNew ? null : addressParam(edit);
    // `?edit=<junk>` is NOT a create form. Falling back to `wallet: null` would
    // open "new agent" for someone whose link named a wallet — a button that
    // deploys a second wallet for the same session key, dressed as an edit
    // screen for the one they already own.
    if (!isNew && wallet === null) return null;
    const addCategory = categoryParam(params.get("allow"));
    return {
      kind: "resolved",
      overlay: {
        kind: "agentForm",
        wallet,
        ...(addCategory === null ? {} : { addCategory }),
      },
    };
  }

  return null;
}

function handleParam(value: string | null): string | null {
  if (value === null) return null;
  // Lowercased BEFORE the check, not after. Handles are lowercase on-chain, and
  // this string arrives from a scanner, a shared link or a person retyping one
  // — `?shop=Ah-Hock-Chicken-Rice` should open the shop rather than silently
  // opening nothing. Same move `/pay/:handle` and `resolveScope` already make.
  const handle = value.trim().toLowerCase();
  return isValidHandle(handle) ? handle : null;
}

function addressParam(value: string | null): Address | null {
  if (value === null) return null;
  const trimmed = value.trim();
  // `isAddress(_, { strict: true })`, never `getAddress`. getAddress does NOT
  // validate EIP-55 — it validates the shape and re-checksums, so a corrupted
  // paste comes back looking repaired and this app would open, and offer to
  // sign for, a wallet nobody owns. Strict accepts an all-lowercase address
  // (which carries no checksum to check) and rejects one whose capitalisation
  // disagrees with its own hash, which is exactly the corrupted-paste case.
  return isAddress(trimmed, { strict: true }) ? trimmed : null;
}

function amountParam(value: string | null): string | undefined {
  if (value === null) return undefined;
  // Shape only, and no ceiling — the ceiling on a price belongs to the payer's
  // wallet, not to the link. Junk prefills nothing rather than rendering
  // `?sgd=<script>` as a price; the pay flow applies the same predicate again on
  // the way in, so an overlay built by hand cannot bypass it either.
  return isAmountShape(value) ? value : undefined;
}

function categoryParam(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  // `Number("")` is 0, and 0 is an integer inside the range — so an empty
  // `?allow=` would arrive as a real category id and tick a box. Rejected here
  // rather than relied on downstream.
  if (trimmed === "") return null;
  // `Number` and not `parseInt`: `parseInt("2abc")` is 2, so junk would tick a
  // real category. The range is the chain's — a categoryId is uint16 < 256
  // because the id doubles as a bit index in AgentPBMWallet's one-word bitmap,
  // and Solidity shifts of 256+ are 0 — so anything outside it is not a
  // category any policy could hold.
  const id = Number(trimmed);
  if (!Number.isInteger(id) || id < 0 || id >= 256) return null;
  /**
   * And it must be a category this build can DRAW.
   *
   * In-range was the bound at first, on the reasoning that the form would
   * render an unknown id as `category 7` the way the denial remedy does. It
   * does not: the form maps `CATEGORY_OPTIONS` alone, so an unlisted id has no
   * chip — but `?allow=` is merged into the form's state before it is rendered,
   * and `categoryBitmapOf` turns that state into the bitmap the payer SIGNS. So
   * `?edit=0x…&allow=7` produced a policy permitting a category the screen
   * never showed them, from a link, with nothing on the form to notice.
   *
   * This param is only ever a starting value for a checkbox, so the honest
   * bound is "a box that exists". The remedy card is unaffected — it passes an
   * id the chain itself returned for a real merchant, and that is always known.
   */
  return isKnownCategory(id) ? id : null;
}

function receiptKeyParam(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > RECEIPT_KEY_MAX) return null;
  return RECEIPT_KEY_SHAPE.test(trimmed) ? trimmed : null;
}

/**
 * Did this URL ASK for an overlay, whatever came of it?
 *
 * The counterpart to `overlayFromQuery` returning null. Refusing to render junk
 * off a URL is the half that matters and it works — but the payer was told
 * nothing, so a link that named a shop we could not read was indistinguishable
 * from a link that only ever opened the app. They land on their wallet tab and
 * cannot tell a broken link from a working one.
 *
 * Deliberately shallow: it answers "was something asked for", not "what was
 * wrong with it". Naming the reason needs a `rejected` arm carrying it out of
 * the parser, which is a bigger change than one sentence to the payer is worth
 * right now. `sgd` and `allow` are excluded because neither is an overlay on its
 * own — they modify one, and a URL carrying only `?sgd=` asked for nothing.
 */
const OVERLAY_NAMING_PARAMS = ["scan", "pay", "shop", "agent", "edit", "receipt"] as const;

export function namesAnOverlay(params: URLSearchParams): boolean {
  return OVERLAY_NAMING_PARAMS.some((key) => params.get(key) !== null);
}
