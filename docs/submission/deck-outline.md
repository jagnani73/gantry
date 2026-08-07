# Stage 1 deck — outline (DRAFT for review)

Two cuts below. **A** is the full 10-slide deck for the Devpost PDF. **B** is a
6-slide condensed version if we want something tighter to actually present.
They share all copy — B is a merge of A, not a rewrite.

Voice rules, applied throughout: no puffery adjectives, concrete nouns
(Maxwell, Changi, 402, XSGD, `CategoryNotAllowed`), every claim carries a
number, a named standard, or a link, and every mock is labelled where it
appears rather than in a footnote.

Judging weights to optimise against: Technical Quality 30 · Real-World Impact
25 · Innovation 20 · Demo 15 · Track Relevance 10.

---

## Cut A — 10 slides (submission PDF)

### 1. Title
**Gantry — one rail, every payer: QR for humans, x402 for AI agents.**

A real, scannable payment QR on the slide, pointing at the live payer page.
Judges can pay a hawker S$1 from their seat during Q&A. Subtitle carries the
Basescan link and "running on Base Sepolia today".

*Test this by printing the slide — a QR that doesn't scan off a projector is
worse than no QR.*

### 2. Problem — the payer-type × rail matrix
Rows: Singaporean with a bank account · tourist · **AI agent**.
Columns: PayNow · cards · Gantry.

- PayNow: free and excellent — for the first row only. It structurally cannot
  serve a foreign payer or a non-human one.
- Cards: work for tourists at ~2–3% merchant fees.
- Agents cannot open bank accounts at all.

Gantry's column is the only one with three ticks. **The pitch is not "cheaper
QR" — PayNow is already free domestically. It is "the payers PayNow cannot
reach."** ~16M international visitors arrive in Singapore each year; the agent
column is new demand that has no rail at all.

### 3. Thesis — one intent, two encodings
The same `PaymentIntent` shown twice, side by side: rendered as a QR code, and
rendered as an HTTP `402 Payment Required` header. Then the punchline:

> x402 standardized how machines pay. Gantry is the rail that lets one merchant
> accept payments from machines and humans alike.

### 4. Architecture
The diagram from `architecture.md`. Two coloured payer paths merging into one
intent, through `GantryCore._settle`, out through the `IGantrySwap` seam to an
XSGD payout and one shared dashboard. Explicit callout that the agent door has
two sub-paths with different trust: standard `exact` (one custodial hop) and
`gantry-pbm` (non-custodial).

### 5. Human door
Three panels: printed standee at a hawker stall → phone payer page → dashboard
row landing in under two seconds. The line that does the work: **the tourist
signs an EIP-3009 authorization and needs zero ETH — the relayer pays gas.**
Onboarding is one form: handle, payout address, category, and the merchant
walks away with a printable QR.

### 6. Agent door
The raw `402` challenge, the policy JSON, and the revert, in that order:

- `PAYMENT-REQUIRED` header offering both schemes (screenshot of the decoded
  challenge, not a redrawing of it).
- `Policy { dailyCap: S$50, categories: [food_beverage], expiry: 30d }`.
- `CategoryNotAllowed(2)` — an actual on-chain revert when the agent tries a
  S$29 powerbank, surfaced verbatim as the x402 `errorReason`.

The point to land: **the denial is a contract revert, not a backend
`if` statement.** MAS Project Orchid's Purpose-Bound Money, applied to AI agents.

### 7. What's real vs what's mocked
A two-column table, verbatim from the repo's honest-notes section. This slide
exists to pre-empt the "vaporware" screening reflex — volunteering the mocks is
what makes the rest of the deck credible.

Real: contracts deployed and verified on Base Sepolia · x402 v2 wire format,
paid end-to-end by an unmodified `@x402/fetch` client · EIP-3009 against real
Circle testnet USDC · on-chain policy denials · live LLM tool-use decisions ·
real phone, real printed QR.

Mocked: `MockXSGD` (XSGD exists on no testnet) · owner-set FX rate, not a market ·
one trusted relayer/facilitator key, which briefly custodies funds on the
standard `exact` path · self-attested merchant categories, no KYC · no fiat
off-ramp.

### 8. Built so far — feasibility evidence
Basescan links for all six contracts · the live dashboard URL · 162 Foundry
tests (fuzz + real-USDC fork) plus 64 TypeScript tests · the commit graph with
`m1`/`m2`/`m3`/`m4` tags. Screening risk this counters: "solo builder, will
never ship."

### 9. Regulation posture
Deliberately modest, three steps: MAS has a framework (Payment Services Act;
Project Orchid explored PBM) → a production Gantry operates *behind* a licensed
PSP, not as one → Gantry is the rail and the policy layer, not the regulated
entity. Says plainly that a hackathon prototype is not a payments licence.

### 10. Fee story, roadmap, and the ask
Fee economics from the demo day itself, on S$26 of takings:

| | Rate | On S$26 |
|---|---|---|
| Cards | ~2.8% | **S$0.73** |
| Gantry | 0.5% | **S$0.13** |

Roadmap: finals → institutions door (payroll, disbursements) → SGQR+
interoperability and mainnet XSGD. Ask: Best Student Team, and the finals slot.
Team: Yashvardhan Jagnani, NTU.

---

## Cut B — 6 slides (condensed)

Same content, merged. Use if we want a presentation deck rather than a reading
deck.

1. **Title + problem** — the scannable QR, plus the payer-type × rail matrix.
   Opens on the gap rather than on us.
2. **Thesis** — one intent, two encodings; the pitch line.
3. **Architecture** — the diagram, both callouts.
4. **What's real vs mocked** — kept whole. This is the slide that earns the
   others; it is the last one to cut.
5. **Fee story + both doors** — the S$0.13-vs-S$0.73 table, with the human and
   agent screenshots flanking it, and `CategoryNotAllowed(2)` shown.
6. **Roadmap + ask** — including one line of regulation posture.

What B loses: the standalone built-so-far evidence slide and the full
regulation slide. Both counter specific screener objections, so if B is used
for the PDF rather than for speaking, fold the Basescan links into slide 4 and
the licensed-PSP line into slide 6 — do not simply drop them.

---

## Facts to keep consistent across every slide

These have all drifted at least once. Check them before export.

| Fact | Correct value |
|---|---|
| Agent model | Gemini `gemini-flash-latest` via the Vercel AI SDK (**not** Claude) |
| Live demo chain | Base Sepolia over a laptop hotspot (**not** local Anvil — never built) |
| FX | `FixedRateSwap`, owner-set (**no** AMM, **no** slippage) |
| Contract names | `GantryCore`, `AgentPBMWallet` (`SettlementRouter`/`PolicyGuard` never existed) |
| Agent door | two sub-paths; `exact` is custodial, `gantry-pbm` is not |
| Human demo amount | S$6.50 → 4.843157 USDC @ 1.3421 |
| Agent demo amount | S$19.50 team lunch → 14.529469 USDC |
| Rejection | GadgetHub SG, S$29 powerbank, `CategoryNotAllowed(2)` |
| Fee comparison | S$0.13 (0.5%) vs **S$0.73** (~2.8%) on S$26 — 26 × 0.028 = 0.728, so S$0.72 is a truncation |
| Dashboard strip | shows net S$25.87 and saved S$0.59, not the gross or the card fee |
