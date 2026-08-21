# Stage 1 deck

10 slides, which is the cap. **Slide** is what goes on screen, verbatim. **Say** is the spoken line, written to be read aloud. **Layout** is how to build it and which screenshot it takes.

Voice rules: every claim carries a number, a named standard, or a link. Every mock is labelled on the slide it appears on, never in a footnote. No puffery adjectives.

Judging weights: Technical Quality 30 · Real-World Impact 25 · Innovation 20 · Demo 15 · Track Relevance 10.

---

## 1 — Title

**Gantry**
One rail, every payer. QR for humans, x402 for AI agents.

- Live on Base Sepolia
- Track 1, Payments & Financial Infrastructure
- Yashvardhan Jagnani, Nanyang Technological University

**Say:** Every payment system ever built assumes the payer is a human. That assumption is about to break.

**Layout:** The Gantry mark large, left. A real scannable QR pointing at the live payer page, right, so judges can pay a hawker from their seat during Q&A. Print the slide to test it: a QR that won't scan off a projector is worse than no QR.

---

## 2 — Two payers nobody can serve

|                                 | PayNow | Cards        | Gantry |
| ------------------------------- | ------ | ------------ | ------ |
| Singaporean with a bank account | yes    | yes          | yes    |
| Tourist                         | no     | yes, at 2–3% | yes    |
| AI agent                        | no     | no           | yes    |

- PayNow is free and excellent, for the first row
- 16 million people visit Singapore each year without a local bank account
- An agent can't open one at all

**Say:** This isn't a cheaper QR code. PayNow is already free domestically. It's the payers PayNow structurally cannot reach.

**Layout:** The table is the slide. Gantry's column is the only one with three ticks, so let that do the work. No screenshot.

---

## 3 — One intent, two encodings

A payment is an intent: merchant M requests S$X. A printed QR and an HTTP `402 Payment Required` are two encodings of it.

- Both doors converge on `GantryCore._settle`
- Swap to XSGD through the `IGantrySwap` seam, with a min-out guard
- The agent door has two sub-paths with different trust: `exact` is custodial, `gantry-pbm` isn't

**Say:** x402 standardized how machines pay. Gantry is the rail that lets one merchant accept payments from machines and humans alike. Two payer paths, one settlement function.

**Layout:** The first mermaid block from the README, exported as a PNG, filling most of the slide. It's also submission artifact #4, so it has to exist as a file anyway. The thesis line sits above it.

---

## 4 — The human door

A tourist lands at Changi with no local bank account.

- Scans a printed sticker, sees S$1.50
- Signs one EIP-3009 authorization
- Holds zero ETH and never sends a transaction. The relayer pays the gas.
- 1.117652 USDC in, 1.50 XSGD out, at a demo rate of 1.3421

**Say:** They sign. They don't transact. That distinction is the whole reason this works for someone who has never held crypto.

**Layout:** The payer confirm screenshot (`143153`) — it already shows the USDC figure, the XSGD figure, the owner-set rate and "Network fee: Paid for you" in one frame.

---

## 5 — The agent door

The same endpoint answers a machine with 402 and an x402 v2 challenge offering two schemes.

| Scheme       | For                            | On-chain payer         | Custody            |
| ------------ | ------------------------------ | ---------------------- | ------------------ |
| `exact`      | Any vanilla x402 client        | The relayer            | One hop, PSP-style |
| `gantry-pbm` | Agents with an on-chain policy | The agent's own wallet | None               |

- An unmodified `@x402/fetch` client pays this endpoint end to end

**Say:** I didn't write the client, and that's the point. I wrote the server and the facilitator. Somebody else's unmodified library pays me.

**Layout:** Table plus the terminal screenshot's top half, the successful run. Keep the custody column visible; it's the honest bit and judges look for it.

---

## 6 — Money with rules, and proof they hold

`Policy { dailyCap: S$50, perTxCap, categories: [food_beverage], expiry: 30d }`

- Set by the wallet's owner, the human, from their own key. `setPolicy` and `revoke` are `onlyOwner`.
- Gantry holds no key that can raise a cap or lift a category
- The agent asks for a S$4 phone cable from an electronics shop and gets `CategoryNotAllowed(2)`
- Well inside every cap it has. The amount was fine, the category wasn't.
- A contract revert, not a backend if-statement. It travels verbatim into the x402 `errorReason`.

**Say:** MAS explored Purpose-Bound Money in Project Orchid. This is that idea aimed at agents. The policy is the perimeter, not the key — and now watch it get told no. That refusal isn't a rule in my backend, it's a contract revert, so the money physically cannot move.

**Layout:** This is the Innovation slide and it carries two beats, so split it cleanly: the policy screenshot (`143246`) left, the terminal's `CategoryNotAllowed` line right, large enough to read from the back. Don't let the policy table crowd the revert.

---

## 7 — What's real, and what's mocked

Real:

- Four contracts deployed and verified on Base Sepolia
- Payments settle in real Circle testnet USDC
- x402 v2 wire format, paid by an unmodified client
- On-chain policy denials
- Live LLM tool-use decisions, Gemini

Mocked:

- MockXSGD, the only mocked token. XSGD exists on no testnet.
- Owner-set FX rate, not a market
- One trusted relayer key, briefly custodial on the `exact` path
- Self-attested merchant categories, no KYC. Registered, never verified.
- No merchant login. The deployed demo payer is one shared account.
- No fiat off-ramp

**Say:** Volunteering the mocks is what makes everything else on these slides believable.

**Layout:** Two columns, equal weight. Resist shrinking the right column. This is the slide that earns the others and it's the last one to cut.

---

## 8 — Built and running

- GantryCore `0xE6289ceA9232af61d7e4F30A67a848c0C322cc93`
- FixedRateSwap `0xd84F8C46E7CAEA01188B6e27E8f1a07aD8311a0d`
- MockXSGD `0xffebE1735e22c274Ae30B2fBb3d4e422a75e3503`
- AgentPBMWalletFactory `0x9e51484b1B79bB3E9EaCEfB3D3510Cc19b7Baac1`
- Live: `gantry-innovatex.vercel.app`
- 446 tests: 191 Foundry (186 in CI; 5 fork tests skip without an RPC URL), 126 shared, 129 backend

**Say:** Solo student build. Everything on this slide is clickable.

**Layout:** Addresses as clickable Basescan links. If there's room, the merchant Overview screenshot behind them at low opacity. Counters the "solo builder can't execute" reflex.

---

## 9 — What it costs, and who carries the liability

|        | Rate  | On S$2,000 a month |
| ------ | ----- | ------------------ |
| Cards  | ~2.8% | S$56               |
| Gantry | 0.5%  | S$10               |

- The fee is skimmed inside the settlement transaction. There's no payout schedule; each payment settles to the merchant's address in the same transaction.
- MAS has the framework already: the Payment Services Act, and Project Orchid for PBM
- A production Gantry runs behind a licensed payment institution, not as one. StraitsX already issues XSGD under that regime.

**Say:** A hawker doing two thousand a month pays me ten dollars, and cards fifty-six. And a hackathon prototype isn't a payments licence — Gantry is the rail and the policy layer, not the regulated entity.

**Layout:** Fee table on top, regulation as three lines beneath a rule. Quote the monthly column out loud, never a single day's takings: a day's total is too small to land, and the live dashboard figures move on every demo run.

---

## 10 — What's next, and the ask

- Passkey merchant wallets. FaceID at signup, no seed phrase, and Gantry never holds the key.
- Real XSGD liquidity behind the same `IGantrySwap` interface, through an aggregator or an RFQ quote
- The institutions door: payroll and disbursements
- SGQR+ interoperability, and mainnet XSGD

**x402 standardized how machines pay. Gantry is the rail that lets one merchant accept payments from machines and humans alike.**

- Best Student Team, and the finals slot
- `github.com/jagnani73/gantry`

**Say:** Asking a hawker for a payout address is the least realistic step in the whole flow, and it's the first thing I'd fix. Every contract is verified on Base Sepolia. The address is on the slide.

**Layout:** Roadmap top half, the pitch line large across the middle, ask and repo beneath. Return to the title composition and repeat the QR, so the deck closes where it opened.

---

## What was merged to reach 10

Recorded so nothing gets quietly re-added:

- **Architecture folded into the thesis (3).** The diagram _is_ the thesis rendered, so showing it a slide later was making the same point twice.
- **The refusal folded into purpose-bound money (6).** Two beats, one argument: here are the limits, here is proof a contract enforces them. This is the densest slide in the deck and the one to rehearse hardest.
- **Regulation folded into the fee slide (9).** Both answer "is this a business", one on economics and one on posture.
- **The roadmap and the ask share the close (10).**

If it has to shrink further, drop 8 before anything else and move the Basescan links onto 7. Never drop 7.

## Facts to check before export

These have each drifted at least once.

| Fact               | Correct value                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Agent model        | Gemini `gemini-flash-latest` via the Vercel AI SDK, **not** Claude                                                       |
| Chain              | Base Sepolia over a laptop hotspot. Local Anvil was never built.                                                         |
| FX                 | `FixedRateSwap`, owner-set. No AMM, no slippage.                                                                         |
| Contract names     | `GantryCore`, `AgentPBMWallet`. `SettlementRouter` and `PolicyGuard` never existed.                                      |
| Agent door         | Two sub-paths. `exact` is custodial, `gantry-pbm` is not.                                                                |
| Human demo amount  | Iced tea S$1.50, 1.117652 USDC at 1.3421                                                                                 |
| Agent demo amount  | 3 iced teas S$4.50, 3.352955 USDC                                                                                        |
| Rejection          | GadgetHub SG, S$4 phone cable, `CategoryNotAllowed(2)`                                                                   |
| Fee                | Quote the monthly figures, S$10 against S$56                                                                             |
| Dashboard tiles    | Live figures that move on every run. Never hardcode them onto a slide.                                                   |
| Test counts        | 191 Foundry, 126 shared, 129 backend. Re-measured 12 Aug 2026.                                                           |
| Agent wallet owner | The payer, on-chain. Revoke lives in the payer app at `/app/agents`, not on the merchant screens.                        |
| Surfaces           | Merchant back-office `/merchant/[handle]/…` and payer app `/app/…`. There is no `/dashboard` screen; the path redirects. |

## Screening risks and what counters each

| Risk                             | Counter, and where it lives                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| "Generic crypto payment gateway" | The payer × rail matrix leads the deck (slide 2)                                                             |
| "The AI agent part is a gimmick" | x402 is a Linux Foundation standard, an unmodified client pays us, the denial is a real revert (slides 5, 6) |
| "Vaporware"                      | Basescan links, live dashboard, scannable QR on slide 1 (slides 1, 8)                                        |
| "Hand-waves regulation"          | Slide 9's modest posture: licensed PSP in front, Gantry as rail                                              |
| "Solo builder can't execute"     | Visible scope discipline. The skipped AMM is documented as skipped, not hidden.                              |
