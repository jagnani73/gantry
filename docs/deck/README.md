# The Stage 1 deck — source

`deck.html` is the source of `docs/gantry-deck.pdf`. Ten slides, 1280×720, self-contained CSS,
rendered to PDF with headless Chrome.

**It reproduces the shipped PDF exactly.** Re-rendering with the command below produces a file of
**644,989 bytes — the same length as the shipped `docs/gantry-deck.pdf`, differing in exactly 14
bytes**, all of them inside the PDF's own `/CreationDate` and `/ModDate` strings:

```
shipped  /CreationDate (D:20260812070753+00'00')   = 2026-08-12 15:07:53 SGT
rebuilt  /CreationDate (D:20260818051632+00'00')
```

That shipped timestamp matches the PDF's file mtime. Nothing else in the two files differs.

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
| `deck.html` | The deck. Final state — the five edits applied. |
| `deck-outline.md` | The content plan behind it, slide by slide, with the spoken lines. |
| `qr-pay.png` | Slide 1. Encodes `https://gantry-innovatex.vercel.app/pay/ah-hock-chicken-rice`. |
| `terminal.png` | Slide 5. Used uncropped. |
| `crop-payer.png` · `crop-policy.png` · `crop-overview.png` | Slides 4, 6, 8 — cropped from `sources/`. |
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
the PDF path — that flag belongs to a separate screenshot pass and does not affect this.

## What is stale in it, and what will go stale

The deck is **the source of the shipped PDF**, so it is deliberately committed unedited: change the
content and it stops reproducing the artifact that was submitted. Anything corrected here should be
a deliberate re-export, not a drive-by.

Known drift as of 18 Aug 2026:

- **Slide 8 states `Tests 446 · Foundry 191 · TypeScript 255`.** Already wrong on `main` (191 / 130
  / 139 = 460) and further out once the pending branches land. Do not quote this slide's numbers —
  run the suites.
- **Slide 7 lists the live model as Gemini.** The agent narrates through AIsa's gateway on
  `feat/aisa-provider`.
- **Slide 8 hardcodes all four contract addresses.** They are correct today, and a
  `pnpm contracts:fresh` would silently invalidate the slide — the deck reads no address from
  `addresses.ts`.
- **The colour tokens are copied verbatim out of `packages/web/src/app/globals.css` rather than
  imported.** A palette change in the app will not reach this deck.
