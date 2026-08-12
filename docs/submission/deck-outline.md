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
The diagram from the README's "How it works" section (the first mermaid block,
which is also submission artifact #4). Two coloured payer paths merging into one
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
- `Policy { dailyCap: S$50, categories: [food_beverage], expiry: 30d }`, set by
  the wallet's **owner** — the human, from their own key.
- `CategoryNotAllowed(2)` — an actual on-chain revert when the agent tries a
  S$4 phone cable, surfaced verbatim as the x402 `errorReason`.

The point to land: **the denial is a contract revert, not a backend
`if` statement** — and the caps are not ours to move either, because
`setPolicy`/`revoke` are `onlyOwner` and Gantry holds no key that can call them.
MAS Project Orchid's Purpose-Bound Money, applied to AI agents.

### 7. What's real vs what's mocked
A two-column table. The source of truth is CLAUDE.md's "What's real vs mocked"
section, condensed in the README's "Prototype scope" note. This slide exists to
pre-empt the "vaporware" screening reflex — volunteering the mocks is what makes
the rest of the deck credible.

Real: contracts deployed and verified on Base Sepolia · x402 v2 wire format,
paid end-to-end by an unmodified `@x402/fetch` client · EIP-3009 against real
Circle testnet USDC · on-chain policy denials · live LLM tool-use decisions ·
real phone, real printed QR.

Mocked: `MockXSGD` — the only mocked token, and unavoidable (XSGD exists on no testnet) · owner-set FX rate, not a market ·
one trusted relayer/facilitator key, which briefly custodies funds on the
standard `exact` path · self-attested merchant categories and self-attested shop
profiles, no KYC — the badge reads "Registered on-chain", and self-service
onboarding is a demo affordance, off on the deployed host because it spends the
relayer's gas key, not because anyone is reviewed
· no login on the merchant back-office, so anyone with the URL can read a shop's
takings · the deployed demo payer is one shared account, so its history is not
private · merchants supply their own payout address rather than being issued a
wallet · no fiat off-ramp.

### 8. Built so far — feasibility evidence
Basescan links for all four contracts · the live merchant back-office URL
(<https://gantry-innovatex.vercel.app/merchant/ah-hock-chicken-rice/overview>,
backed by <https://gantry-backend.onrender.com>) · 191
Foundry tests (186 run in CI; the 5 real-USDC and PBM fork tests skip themselves
without a fork RPC URL and are run locally) plus 255 TypeScript tests (126 shared,
129 backend) · the commit graph with `m1`/`m2`/`m3`/`m4` tags. Screening risk this
counters: "solo builder, will never ship."

### 9. Regulation posture
Deliberately modest, three steps: MAS has a framework (Payment Services Act;
Project Orchid explored PBM) → a production Gantry operates *behind* a licensed
PSP, not as one → Gantry is the rail and the policy layer, not the regulated
entity. Says plainly that a hackathon prototype is not a payments licence.

### 10. Fee story, roadmap, and the ask
Fee economics as a rate, extrapolated to real volume — a day's takings are
too small to land as an absolute:

| | Rate | On the demo's S$6.00 | On a hawker's S$2,000/month |
|---|---|---|---|
| Cards | ~2.8% | S$0.168 | **S$56** |
| Gantry | 0.5% | S$0.03 | **S$10** |

Roadmap: finals → **passkey merchant wallets** (a hawker signs up with FaceID,
no seed phrase, no app — Gantry never holds the key) → institutions door
(payroll, disbursements) → SGQR+ interoperability and mainnet XSGD. Ask: Best Student Team, and the finals slot.
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
5. **Fee story + both doors** — the S$10-vs-S$56-a-month table, with the human and
   agent screenshots flanking it, and `CategoryNotAllowed(2)` shown.
6. **Roadmap + ask** — including one line of regulation posture.

What B loses: the standalone built-so-far evidence slide and the full
regulation slide. Both counter specific screener objections, so if B is used
for the PDF rather than for speaking, fold the Basescan links into slide 4 and
the licensed-PSP line into slide 6 — do not simply drop them.

---

## Devpost submission copy

The deck is one of five artifacts; these are the fields around it.

- **One-liner:** One rail, every payer: QR for humans, x402 for AI agents.
- **Elevator paragraph:** lead with PayNow's tourist gap and the agent gap, close
  on feasibility, "a working prototype runs on Base Sepolia today", with the
  Basescan link inline.
- **Track:** 1, Payments & Financial Infrastructure.
- **Entry:** Student Group (solo). Claim Best Student Team explicitly.
- **Artifacts:** deck PDF · 60–90s demo clip · the public repo · the architecture
  diagram PNG (the first mermaid block in the README) · the live back-office URL
  <https://gantry-innovatex.vercel.app/merchant/ah-hock-chicken-rice/overview>.
  Warm the backend before sending anyone a link; a cold Render instance takes
  ~50s on the first hit.

## Screening risks and what counters each

| Risk | Counter, and where it lives |
|---|---|
| "Generic crypto payment gateway" | The payer-type × rail matrix leads the deck (slide 2) |
| "The AI agent part is a gimmick" | x402 is a Linux Foundation standard, an unmodified client pays us, and the denial is a real revert (slide 6) |
| "Vaporware" | Basescan links, live dashboard, commit graph, scannable QR on slide 1 (slides 1, 8) |
| "Hand-waves regulation" | Slide 9's modest posture: licensed PSP in front, Gantry as rail |
| "Solo builder can't execute" | Visible scope discipline — the skipped AMM is *documented as skipped*, not hidden |

## Facts to keep consistent across every slide

These have all drifted at least once. Check them before export.

| Fact | Correct value |
|---|---|
| Agent model | Gemini `gemini-flash-latest` via the Vercel AI SDK (**not** Claude) |
| Live demo chain | Base Sepolia over a laptop hotspot (**not** local Anvil — never built) |
| FX | `FixedRateSwap`, owner-set (**no** AMM, **no** slippage) |
| Contract names | `GantryCore`, `AgentPBMWallet` (`SettlementRouter`/`PolicyGuard` never existed) |
| Agent door | two sub-paths; `exact` is custodial, `gantry-pbm` is not |
| Human demo amount | iced tea S$1.50 → 1.117652 USDC @ 1.3421 |
| Agent demo amount | 3 iced teas S$4.50 → 3.352955 USDC |
| Rejection | GadgetHub SG, S$4 phone cable, `CategoryNotAllowed(2)` |
| Fee comparison | 0.5% vs ~2.8% — quote the monthly figures (S$10 vs S$56), not the S$6 day |
| Overview tiles | net S$5.97 ("Collected, **last 7 days**") and S$0.13 ("Saved vs cards") — the S$0.13 is the SAVING, not Gantry's cut. The middle tile is "Paid by", an agent/human split bar, **not** a money figure |
| Agent wallet owner | the **payer**, on-chain. `setPolicy`/`revoke` are `onlyOwner`; revoke is in the payer app at `/app/agents`, not on the merchant screens |
| Surfaces | merchant back-office `/merchant/[handle]/…` and payer app `/app/…`. There is no `/dashboard` screen any more — the path redirects |
| Test counts | **Re-measure before quoting.** Slide 8 is the only place they appear, so nothing catches drift; they have silently gone wrong twice. `pnpm --filter @gantry/shared test` and `pnpm --filter @gantry/backend test` each print the real number in one line |
| Agent-door e2e script | `pnpm --filter **@gantry/agent** e2e:pbm`. Its siblings `e2e:pay` and `x402:buy` are `@gantry/backend` |
