# The deck, and its source

`deck.html` is the source of `docs/gantry-deck.pdf`. Ten slides, 1280×720, self-contained CSS,
rendered to PDF with headless Chrome.

**The PDF is a build output: edit the HTML and re-render, or the repo carries a source and an
artifact that disagree with nothing announcing it.**

This folder was committed unedited until 21 Aug 2026, so that a re-render reproduced the Stage 1
PDF byte for byte bar the 14 inside its own `/CreationDate` and `/ModDate`. That guarantee was
spent deliberately: slide 7 claimed USDC-only settlement and credited Gemini, slide 8 stated 446
tests, and a deck read at the finals is worth more than one that still matches an artifact
screening had already passed. **The Stage 1 PDF now survives only in git history**, at
`git show 2b3a5f3:docs/gantry-deck.pdf` (644,989 bytes).

## Why this folder exists

This source was written to a scratch directory on 12 Aug 2026 and deleted the same day, which is
why `CLAUDE.md` said for a week that the deck's *"source is no longer kept — treat the PDF as
final"*. It was recovered on 18 Aug from a session transcript by replaying the one `Write` and five
`Edit` operations that produced it, then verified against the shipped PDF byte-for-byte.

It is committed here so that cannot happen twice. The deck is one of five submission artifacts and
it was, for six days, an output nobody could regenerate.

## Files

| File | What it is |
|---|---|
| `deck.html` | The deck. Final state, with the five edits applied. |
| `deck-outline.md` | The content plan behind it, slide by slide, with the spoken lines. |
| `qr-pay.png` | Slide 1. Encodes `https://gantry-innovatex.vercel.app/pay/ah-hock-chicken-rice`. |
| `terminal.png` | Slide 5. Used uncropped. |
| `crop-payer.png` · `crop-policy.png` · `crop-overview.png` | Slides 4, 6, 8, cropped from `sources/`. |
| `sources/` | The uncropped screenshots the three crops came from. Kept because they otherwise live only in a personal `OneDrive\Pictures\Screenshots` folder. |

## Rebuild

Fonts come from `fonts.googleapis.com`, so **rendering needs network**.

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --headless=new --disable-gpu --no-pdf-header-footer `
  --allow-file-access-from-files --virtual-time-budget=20000 `
  --print-to-pdf="gantry-deck.pdf" "file:///<abs-path>/deck.html"
```

Slide geometry is `@page { size: 1280px 720px; margin: 0 }` plus
`.slide { width: 1280px; height: 720px; page-break-after: always }`. There is no `--window-size` on
the PDF path. That flag belongs to a separate screenshot pass and does not affect this.

## What is stale in it, and what will go stale

Now that the reproduction guarantee is spent, edits here are ordinary. But the PDF is a build
output, so **an edit that is not re-exported is worse than no edit**: the repo would then carry a
source and an artifact that disagree, with nothing announcing it. Always re-render.

Fixed on 21 Aug 2026: slide 7's USDC-only settlement claim and its "Gemini" model credit, and slide
8's test counts. What remains:

- **Slide 8's test counts go stale by construction.** They read `Tests 566 · Foundry 201 (196 in CI)
  · TypeScript 365 (189 + 172 + 4)`, counted by re-running all four suites on 21 Aug 2026. Every
  branch that adds tests makes this wrong. **Never adjust these by arithmetic**: the 550 previously
  recorded here was wrong on two suites at once, which no amount of adding up would have caught. Run
  the suites.
- **Slide 8 hardcodes all four contract addresses.** They are correct today, and a
  `pnpm contracts:fresh` would silently invalidate the slide, since the deck reads no address from
  `addresses.ts`.
- **The colour tokens are copied verbatim out of `packages/web/src/app/globals.css` rather than
  imported.** A palette change in the app will not reach this deck.
- **Instrument Sans has never actually embedded.** Both the shipped PDF and every re-render carry
  `ArialMT` for the sans and IBM Plex Mono for the mono, so the headline typeface in the PDF is
  Arial regardless of what the CSS asks for. The mono fetches from Google Fonts and the sans does
  not. Not worth fixing before the finals; worth knowing before anyone "corrects" a font difference
  they spot between the deck and the app.
