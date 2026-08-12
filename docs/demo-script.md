# Demo scripts (DRAFT for review)

Three things here: the 3-minute finals script, the 60–90s Stage 1 clip, and the
Q&A prep. Rehearse against the finals script; record against the clip script.

**Stage setup.** The merchant back-office
(`/merchant/ah-hock-chicken-rice/overview`) never leaves the projector. The
phone (via scrcpy) and the agent terminal swap into a side panel; the payer app's
agents screen (`/app/agents`) is a third tab, because that is where revoke now
lives. Everything runs against **Base Sepolia over the laptop's own hotspot** —
never venue wifi. Local Anvil was considered and deliberately not built; the
hotspot covers the same failure mode without a second orchestration path to
maintain.

**Before every run:** `pnpm demo:reset` — it provisions/tops up and re-arms the
demo agent wallet, registers the demo shops on-chain if they are missing, checks
`gadgethub-sg` is still registered, and prints the funder's ETH
**and** USDC balances, swapping ETH→USDC if the USDC has run low. Check both
numbers. Every register and every settle spends ETH; every payer grant and wallet
top-up spends USDC, which cannot be minted. The re-arm is signed by the **demo
payer's** key, not the relayer's — `setPolicy` is `onlyOwner` and the payer owns
the wallet — so that key needs a little ETH, which the faucet's gas leg supplies.

It does **not** clear the merchant feed, and nothing does: every host indexes the
same chain from the same block and shows everything it finds, which is what keeps
this laptop and the deployed backend showing the same book. **If a run needs an
empty feed, deploy a fresh core first** — `pnpm contracts:fresh`, then commit the
new addresses and rebuild both hosts. Budget minutes for that, not seconds, and
never do it on demo day.

**The onboarding cooldown survives `demo:reset`** — it's a 30s in-process
per-IP guard, so two registration takes inside 30s will 429. Space them, or
restart the backend between takes.

**Agent prompts must carry the amount.** "Buy 3 iced teas for the team (S$4.50) from Ah
Hock", not "buy lunch". An amount-less prompt lets the live model pick its own
basket — during testing it once spent its entire remaining S$30.50 budget.

---

## 3-minute finals script

| Time | Beat | What's on screen | What I say |
|---|---|---|---|
| 0:00–0:12 | **Hook** | Title slide, dashboard behind | "Every payment system ever built assumes the payer is a human. That assumption is about to break." |
| 0:12–0:22 | **Scene** | Printed QR standee held up | "This is Ah Hock, Maxwell Food Centre. One printed sticker. He set it up in about two minutes and he has never heard of a blockchain." |
| 0:22–0:45 | **Tourist pays** | Phone mirrored: scan → S$1.50 → Confirm | "A tourist lands at Changi with no Singapore bank account. She scans. She signs one authorization — she holds no ETH, and she never sends a transaction. Our relayer pays the gas." |
| 0:45–1:00 | **WOW 1** | Dashboard: chime, row slides in — 1.12 USDC in, S$1.50 XSGD out, net and fee inline on the row | "Under two seconds. 1.12 USDC came in — real Circle USDC, not a testnet toy — and 1.50 XSGD went out, swapped atomically inside the settlement contract. Ah Hock only ever sees Singapore dollars." |
| 1:00–1:08 | **Pivot** | Dashboard stays up | "That's the easy customer. My next customer has no hands." |
| 1:08–1:40 | **Agent lunch** | Terminal: prompt → 402 → reasoning → 200 OK | "I tell an AI agent to buy the team lunch. It hits the endpoint, gets back HTTP 402 Payment Required — that's x402, a Linux Foundation standard with clients shipping today. It reads the price, checks its own on-chain policy, and pays. S$4.50." |
| 1:40–1:48 | **Convergence** | Dashboard: second row, 🤖 Agent badge | "Same contract. Same feed. Ah Hock does not know or care that one of these customers is software." |
| 1:48–2:12 | **WOW 2** | Terminal only — the agent narrates the revert | "Now watch it get told no. I ask it for a S$4 phone cable from an electronics shop — well inside its budget. Its wallet allows food and beverage only — and that's not a rule in my backend, it's a **contract revert**. `CategoryNotAllowed`. The money physically cannot move." |
| 2:12–2:26 | **Revoke** | Payer app `/app/agents`: cap meter, tap Revoke, confirm | "MAS explored Purpose-Bound Money in Project Orchid. This is that idea pointed at AI agents — a daily cap, an allowlist, an expiry, and a kill switch the human owner holds. And *holds* is literal: this wallet is owned by me on-chain, so that's my signature, not a Gantry API call. One tap, done." |
| 2:26–2:44 | **Fee tiles** | Back to the merchant Overview screen | "Two payments. Ah Hock keeps five ninety-seven of six dollars — the third tile is what we saved him. Three cents is our cut. Scale it: a hawker doing two thousand a month pays us ten dollars, and cards fifty-six." |
| 2:44–3:00 | **Close** | Title slide + Basescan address | "x402 standardized how machines pay. Gantry is the rail that lets one merchant accept payments from machines and humans alike. Every contract is verified on Base Sepolia — the address is on the slide." |

### Optional opening beat — live onboarding (~25s, decide against the clock)

Insert between 0:12 and 0:22, pushing everything back by ~25s (so trim the
revoke beat to ~8s, or skip narrating the row's FX detail, to absorb it).

> Open `/onboard`, type a handle — availability turns green as I type, and it's
> green because we're reading the chain. Shop name, stall location, one line
> about it, paste a payout address, pick "Food & Beverage", hit register. That's
> a real on-chain transaction, ~5s.
> Success card: Basescan link, and a button that prints the QR code. **"This
> shop did not exist ninety seconds ago."** Then pay it.

**Why it's strong:** it turns the standee from a prop into something we made on
stage, and it's the only beat that demonstrates the "2-minute onboarding" claim
rather than asserting it.

**Why it's optional:** it adds a *third* live on-chain transaction to the
riskiest three minutes of the project, and it spends time that currently goes
to the two beats that score Innovation. Verified working end-to-end (see
`kopi-corner-sg` on Basescan), so this is purely a clock decision.

**Decide after rehearsal 5.** If the full script lands under 2:40 consistently,
add it. If not, it lives in the clip and the deck only.

### Failure drills

| If | Then |
|---|---|
| Phone won't scan | Type the short URL — it's on the standee under the QR |
| Settlement >5s | Keep talking; the row lands. Don't watch it in silence |
| Row never lands | Hotkey the backup clip for that beat, say "here's the recorded run", continue |
| Agent LLM stalls | It self-fallbacks to scripted narration at 8s with identical wire traffic. Say nothing — the payment is real either way |
| RPC dies entirely | Full-run backup video, narrate over it, and be honest that we're on the recording |
| Register says it failed | Open `/pay/<handle>` BEFORE retrying. If it loads, the tx mined past the 20s receipt cap and you're already registered — the form now detects this and shows the success card, but check before burning a second handle |
| Revoke button errors | The revoke is the *payer's* transaction, so the demo account needs gas. `pnpm demo:reset` funds it; if it still fails, the relayer's ETH is near its reserve — check the reset output's ETH line, because that also means every settlement is about to fail |
| Agents screen is empty | The list comes from `WalletCreated` logs filtered by owner, so an empty list means the demo account owns no wallet yet. `pnpm demo:reset` provisions one |
| Wallet, activity and agents ALL empty, and the address is unfamiliar | Someone tapped Settings → "Use my own wallet instead" on this browser. The choice is stored in `localStorage` and survives reloads. Settings → "Go back to the demo account" restores it; nothing was lost, the screens were showing a different account's (empty) history |

---

## Stage 1 clip — 60–90s (target 80s, record 10 Aug AM)

Captions burned in; voiceover recorded separately so a muffed line costs one
audio take, not one screen take. Shoot each screen action twice.

| # | Length | Shot |
|---|---|---|
| 1 | 6s | Title card — "One rail, every payer" + the Gantry mark |
| 2 | 10s | `/onboard`: type a handle, availability flips green, register → success card with the Basescan link |
| 3 | 8s | Real hand, real phone, scanning the printed standee |
| 4 | 10s | Payer page: S$1.50, tap "Confirm & pay — no gas needed" |
| 5 | 10s | Dashboard: chime, row lands — 1.12 USDC in, S$1.50 XSGD out, net and fee inline on the row |
| 6 | 14s | Terminal: the 402 challenge scrolling, the agent's reasoning, `200 OK` |
| 7 | 10s | Dashboard: both rows side by side, Human badge and Agent badge |
| 8 | 8s | The phone-cable attempt → red `CategoryNotAllowed` row |
| 9 | 6s | Closing card: pitch line, repo URL, Basescan address |

Total ≈ 82s. If it runs long, shot 2 is the one to cut — onboarding is well
covered by the deck.

---

## Q&A prep — nine hard answers

**1. Why not just use PayNow?**
For a Singaporean paying a Singaporean, you should — it's free and it works.
PayNow requires a Singapore bank account, so it cannot serve the ~16M
international visitors who arrive each year, and it certainly cannot serve a
piece of software. We're not competing with PayNow's domestic case; we're covering the
payers it structurally cannot reach.

**2. Who carries the regulatory liability?**
Not us, and we're not claiming otherwise. In production Gantry sits behind a
licensed payment institution under the Payment Services Act — StraitsX already
issues XSGD under that regime. Gantry is the rail and the policy layer; the
licensed entity holds the customer relationship and the obligations. A hackathon
prototype is not a payments licence and this deck doesn't pretend it is.

**3. What if the agent's session key is stolen?**
Then the attacker gets exactly what the policy allows — up to S$50 a day, at
food merchants, until the expiry, and only until the owner revokes. That's the
whole design: **the policy is the perimeter, not the key.** Compare a stolen card
number, where the limit is the credit line. The key is a capability, not an
identity. And the perimeter isn't ours to move: the wallet is owned on-chain by
the human, `setPolicy` and `revoke` are `onlyOwner`, and Gantry holds no key that
can raise a cap or lift a category — so compromising Gantry doesn't widen the
agent's allowance either.

**4. Why does this need a blockchain at all?**
Honestly: the QR half doesn't, strictly. A bank could build it. The agent half
does, and for one specific reason — the spending policy has to be enforced
somewhere the agent's own software can't reach. If the cap lives in the agent's
code, a compromised agent edits it. On-chain, the denial is a revert: the funds
cannot move, and you can see it happen. That plus a settlement asset an agent
can hold without a bank account is what makes it a chain problem.

**5. Is 0.5% a real business?**
It's a placeholder that's honest about its own arithmetic: 0.5% is well above
the on-chain cost of settlement and well below the ~2.8% cards charge, which
leaves room for the licensed PSP in the middle to take a cut and still beat
cards. The real answer is that agent payments are a new volume category, not a
margin fight with Visa.

**6. Is agent commerce actually a thing, or is this speculative?**
Partly speculative, and I'd rather say so. What isn't speculative: x402 launched
in May 2025, was contributed to the Linux Foundation, and its foundation went
operational in July 2026 with 40 founding members including Google, Visa and
Cloudflare. Client libraries ship today, and our endpoint is paid end-to-end by
an *unmodified* one. We built for a standard that exists rather than inventing a
protocol and hoping.

**7. Where does the FX rate come from?**
On testnet, from me — it's an owner-set fixed rate at 1.3421 and it's labelled
as such everywhere, because XSGD exists on no testnet at all. That's why
settlement talks to an `IGantrySwap` interface rather than to a pool: production
swaps in real XSGD liquidity through an aggregator or an RFQ quote, optionally
bounded by a Chainlink SGD/USD check. The contract already enforces its own
minimum-out by measuring its balance delta, so the guarantee doesn't depend on
trusting whatever is behind the interface.

**8. There are no chargebacks. What about consumer protection?**
Correct, and that's a genuine limitation of settlement finality, not something I
can hand-wave. Two partial answers: for the agent side, the policy layer is
*preventive* protection — the money never leaves in the first place, which is
strictly better than clawing it back. For the human side, a production
deployment would put a licensed PSP in the flow who can hold funds in escrow for
a dispute window. We didn't build that.

**9. How does a hawker who has never held crypto actually receive the money?**
Today the onboarding form asks for a payout address, and that's the least
realistic step in the whole flow — I'd rather flag it than defend it. The
production answer is a **passkey smart account**: the merchant creates a wallet
with FaceID at signup, no seed phrase and no app to install, and Gantry never
holds the key. That's a shipping pattern, not a research idea — Coinbase Smart
Wallet and Privy both do it today.

What we deliberately did *not* do is generate and hold the merchant's key for
them. That would make Gantry the custodian of hawker revenue and turn a
non-custodial rail into an unlicensed money service — the exact opposite of the
regulation posture on slide 9. The payout address is validated as strict EIP-55
rather than just well-formed hex, because `setMerchantPayout` is gated on the
current payout: a mistyped-but-valid address would be unrecoverable by anyone.

### Rapid-fire spares

- *Why XSGD and not USDC to the merchant?* A hawker prices in dollars and pays
  rent in dollars. FX risk is exactly what a merchant shouldn't hold.
- *Why Base?* Cheap L2, real Circle USDC with a faucet on testnet, and it's
  where x402 tooling actually runs.
- *Did you write the x402 client?* No — that's the point. We wrote the server
  and the facilitator; the client is `@x402/fetch`, unmodified.
- *Is the LLM making the payment?* No. The model chooses and narrates; the
  signing and the HTTP live in tools it cannot reach. If the model times out, a
  scripted path sends identical wire traffic.
- *Can anyone register as a merchant?* On the contract, yes, and that is the
  point: `registerMerchant` is permissionless. On the demo host the form is open
  too, which is the 2-minute onboarding beat. It is closed on the deployed
  instance for one reason only, and it is not vetting: that form spends our gas
  key, and we will not leave an unauthenticated ETH spend on the public
  internet. Nothing in Gantry reviews or verifies a merchant. Categories are
  self-attested and there is no KYC anywhere in the system.
- *Solo project?* Yes. Solo student entry, NTU.
