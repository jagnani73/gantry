# Demo scripts

Three things here: the 3-minute finals script, the Stage 1 clip (shot and
submitted — kept as a record), and the Q&A prep. Rehearse against the finals
script.

**What changed on 19 Aug, and why the script did.** Six capabilities landed after
this file was last written: the dual-door pay link, machine-readable discovery,
EURC as a real second input currency, a public refusal verifier, the denial →
remedy loop, and the machine door on every shop's public page. Three minutes
cannot hold six more beats, and padding the script is how a demo overruns.

So almost nothing was *added*. The existing beats were rewired to **demonstrate
what they used to assert**:

- the tourist now pays in **euros**, which costs no extra seconds and turns
  "any currency in, Singapore dollars out" from a claim into two live rows;
- the agent now pays **the same URL the tourist just used**, which makes the
  convergence beat mechanical instead of narrated;
- the revoke beat gained the **one-tap remedy**, on a screen already open.

Discovery, the verifier and the machine-door card are **deliberately not in the
three minutes**. They are the best Q&A answers this project has and they are all
things a judge can run themselves — see *Let them poke it*.

**Stage setup.** The merchant back-office
(`/merchant/ah-hock-chicken-rice/overview`) never leaves the projector. The
phone (via scrcpy) and the agent terminal swap into a side panel; the payer app's
agents screen (`/app/agents`) is a third tab, because that is where revoke and
the remedy tap both live. Everything runs against **Base Sepolia over the
laptop's own hotspot** — never venue wifi. Local Anvil was considered and
deliberately not built; the hotspot covers the same failure mode without a second
orchestration path to maintain.

**Before every run:** `pnpm demo:reset` — it provisions/tops up and re-arms the
demo agent wallet, registers the demo shops on-chain if they are missing, checks
`gadgethub-sg` is still registered, and prints the funder's ETH, **USDC and
EURC** balances, swapping ETH→USDC if the USDC has run low. Check all three.
Every register and every settle spends ETH; every payer grant and wallet top-up
spends stablecoin, and **EURC cannot be bought** — Base Sepolia has no EURC
market at all, so Circle's faucet is the only tap and `demo:reset` will warn
before it matters. The re-arm is signed by the **demo payer's** key, not the
relayer's — `setPolicy` is `onlyOwner` and the payer owns the wallet — so that
key needs a little ETH, which the faucet's gas leg supplies.

**Set the payer app to EUR before the run.** Settings → *Currency you pay in* →
**€ EUR**. It is a stored preference, so it survives reloads, but it is per
browser — check it on the phone, not on the laptop. Without it the tourist beat
still works and simply pays dollars, which costs the euro line and nothing else.

**Set `AGENT_USE_PAY_LINK=1` in `packages/agent/.env` before the run**, or the
agent beat's "same link" line is not true — see the note under the table.

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
| 0:22–0:45 | **Tourist pays, in euros** | Phone mirrored: scan → S$1.50 → Confirm | "A tourist lands at Changi with no Singapore bank account — and no Singapore dollars either. She holds euros. She scans, and she signs one authorization: no ETH, no transaction of her own. Our relayer pays the gas." |
| 0:45–1:00 | **WOW 1 — any currency in** | Dashboard: chime, row slides in — 0.99 EURC in, S$1.50 XSGD out, net and fee inline | "Under two seconds. Ninety-nine cents of **euros** came in — Circle's real EURC, not a mock — and one-fifty in Singapore dollars went out, swapped atomically inside the settlement contract. Ah Hock never sees a euro. He cannot: the output token is `immutable` in the contract." |
| 1:00–1:08 | **Pivot** | Dashboard stays up | "That's the easy customer. My next customer has no hands." |
| 1:08–1:40 | **Agent lunch — the same URL** | Terminal: prompt → 402 → reasoning → 200 OK | "I tell an AI agent to buy the team lunch, and I give it **the same link the tourist just opened**. A browser gets a payment page. A machine gets HTTP 402 Payment Required — that's x402, a Linux Foundation standard with clients shipping today. It reads the price, checks its own on-chain policy, and pays. S$4.50, in dollars this time." |
| 1:40–1:48 | **Convergence** | Dashboard: second row, 🤖 Agent badge | "Same URL, same contract, same feed — one paid in euros, one in dollars, both landed as Singapore dollars. Ah Hock does not know or care that one of these customers is software." |
| 1:48–2:12 | **WOW 2 — the refusal** | Terminal only — the agent narrates the revert | "Now watch it get told no. I ask it for a S$4 phone cable from an electronics shop — well inside its budget. Its wallet allows food and beverage only — and that's not a rule in my backend, it's a **contract revert**. `CategoryNotAllowed`. The money physically cannot move." |
| 2:12–2:30 | **Revoke, and the way back** | Payer app `/app/agents`: cap meter → declined receipt → *Allow Electronics* → back → tap Revoke | "MAS explored Purpose-Bound Money in Project Orchid. This is that idea pointed at AI agents — a cap, an allowlist, an expiry, and a kill switch the human holds. And *holds* is literal: this wallet is mine on-chain, so this is my signature, not a Gantry API call. The refusal isn't a dead end either — one tap widens the rule. And one tap stops the agent dead." |
| 2:30–2:46 | **Fee tiles** | Back to the merchant Overview screen | "Two payments. Ah Hock keeps five ninety-seven of six dollars — the third tile is what we saved him versus cards. Three cents is our cut. Scale it: a hawker doing two thousand a month pays us ten dollars, and cards fifty-six." |
| 2:46–3:00 | **Close** | Title slide + Basescan address | "x402 standardized how machines pay. Gantry is the rail that lets one merchant accept payments from machines and humans alike — in whatever currency they hold. Every contract is verified on Base Sepolia; the address is on the slide." |

**Say "the same link" only if you actually used it — set `AGENT_USE_PAY_LINK=1`.**
The agent beat is stronger because the URL is genuinely shared, and that is
checkable by anyone in the room afterwards, so it has to be true on the night.
The agent's DEFAULT endpoint is `POST /api/order/:handle` — the same `accepts[]`
by reference, but not literally the same string, and "the same link" would be a
claim the audience could disprove by watching the terminal.

With the flag set it fetches `GET /pay/:handle?sgd=`, the exact URL the phone
opened. Proven end to end:
[`0xf0099f0e…`](https://sepolia.basescan.org/tx/0xf0099f0e7ef8cf5b84dfef26228c1b8bf931c6f304bdbe5b3e95acc07a2a839b),
on-chain payer the policy wallet. `x402:buy -- --link` proves the same door for a
vanilla client.

**The fee tile trap.** The *Saved vs cards* tile reads **S$0.13**. That is the
card fee minus ours, not our cut. Never say "we took thirteen" — our cut is three
cents, and the gross and the card fee are not on screen at all.

### Optional opening beat — live onboarding (~25s, decide against the clock)

Insert between 0:12 and 0:22, pushing everything back by ~25s (so trim the
revoke beat to ~8s and drop the remedy tap, to absorb it).

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
riskiest three minutes of the project, and it now competes with the remedy tap
for the same seconds. Verified working end-to-end (see `kopi-corner-sg` on
Basescan), so this is purely a clock decision.

**Decide after rehearsal 5.** If the full script lands under 2:40 consistently,
add it. If not, it lives in the clip and the deck only.

### Let them poke it — the three best answers we do not perform

None of these fit the three minutes. All are stronger *because* the judge runs
them rather than watching them, and all work on the deployed host with no key.

**"Prove the machine door is real."** One curl, on stage or on their laptop:

```bash
curl -i 'https://gantry-backend.onrender.com/pay/ah-hock-chicken-rice?sgd=4.50'
```

402 with a live challenge. Add `-H 'Accept: text/html'` and the same URL 302s
into the payment page. That is the whole thesis in two commands. It is also
rendered, decoded, on every shop's public page at `/m/<handle>` for anyone who
will not open a terminal.

**"How would an agent find you without being told?"**

```bash
curl https://gantry-backend.onrender.com/discovery/resources
```

Every registered shop as a payable resource, in the x402 Bazaar's shape — **the
shape is theirs, the index is ours, and we publish to nobody's catalog**, so do
not call it a Bazaar registry. `x402:buy -- --discover` closes the loop live:
find a shop, pay its listing verbatim, settle, with no handle hardcoded anywhere.

**"Why should I believe your refusal was real?"** This is the strongest one, and
the honest framing is the point:

```bash
pnpm --filter @gantry/backend verify:denial -- --tx <cancelTxHash>
```

It reads the policy, the spend counter, the balance and the merchant's category
**at the denial's block**, recomputes the wallet's decision and compares it to
what we recorded. Every input is a public getter. **It can return
`contradicted`** — a checker that can only agree proves nothing — and it still
does not check the signature, so it proves the wallet *would have refused*, never
that the agent *asked*. Say "re-derivable from public state". Never
"reproducible", never "chain-proven".

### Failure drills

| If | Then |
|---|---|
| Phone won't scan | Type the short URL — it's on the standee under the QR |
| Settlement >5s | Keep talking; the row lands. Don't watch it in silence |
| Row never lands | Hotkey the backup clip for that beat, say "here's the recorded run", continue |
| Agent LLM stalls | It self-fallbacks to scripted narration at 8s with identical wire traffic. Say nothing — the payment is real either way |
| Agent talks but no row lands, and it exits 1 | The zero-tool guard (the `silent` outcome in `run.ts`). The model narrated without calling a tool, so **nothing was paid** — the gateway is answering tool calls as prose. Do not re-run it hoping; `unset AISA_API_KEY` to fall back to Gemini and go again. This is the one failure where the narration is ahead of the money, so say nothing until a row lands |
| RPC dies entirely | Full-run backup video, narrate over it, and be honest that we're on the recording |
| Register says it failed | Open `/pay/<handle>` BEFORE retrying. If it loads, the tx mined past the 20s receipt cap and you're already registered — the form now detects this and shows the success card, but check before burning a second handle |
| Revoke button errors | The revoke is the *payer's* transaction, so the demo account needs gas. `pnpm demo:reset` funds it; if it still fails, the relayer's ETH is near its reserve — check the reset output's ETH line, because that also means every settlement is about to fail |
| Agents screen is empty | The list comes from `WalletCreated` logs filtered by owner, so an empty list means the demo account owns no wallet yet. `pnpm demo:reset` provisions one |
| Wallet, activity and agents ALL empty, and the address is unfamiliar | Someone tapped Settings → "Use my own wallet instead" on this browser. The choice is stored in `localStorage` and survives reloads. Settings → "Go back to the demo account" restores it; nothing was lost, the screens were showing a different account's (empty) history |
| **The phone shows a USDC balance when you expected euros** | The currency is a per-browser preference and you set it on the laptop. Settings → *Currency you pay in* → **€ EUR** on the phone. Harmless: the beat still settles, just in dollars |
| **`demo:reset` prints an EURC warning** | The relayer is low and EURC cannot be swapped for — no pool exists on this testnet at any fee tier. Circle's faucet is the only tap. Run the tourist beat in **USD** tonight and top up after; nothing else in the demo touches EURC |
| **`demo:reset` exits DEGRADED with `Missing or invalid parameters`** | Almost certainly an RPC blip, not your code — the public fallback node answers `no backend is currently healthy` under load and that is what surfaces. **Re-run it first.** If it repeats, check three things: relayer `latest` vs `pending` nonce (equal = nothing stuck), `eth_getCode` on the relayer (`0x` = no 7702 delegation), and its ETH |
| **The agent refuses with `agent_currency_mismatch`** | It was told to pay in a currency its wallet does not hold. One currency per agent, enforced at the door — `AGENT_PAY_TOKEN` in `packages/agent/.env` must match what the pinned wallet actually holds. "Kopi Runner" holds USDC; "Euro Runner" holds EURC |

---

## Stage 1 clip — 60–90s (SHOT AND SUBMITTED, kept as a record)

Submitted 11 Aug. It predates everything in the *What changed* note above, so it
shows the USDC-only flow and no pay link. **That is fine and it is not being
re-cut** — Stage 1 is judged on what was submitted. Recorded here so nobody
mistakes it for a plan.

Captions burned in; voiceover recorded separately so a muffed line costs one
audio take, not one screen take. Each screen action shot twice.

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

Total ≈ 82s.

---

## Q&A prep — twelve hard answers

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
On testnet, from me — owner-set fixed rates, 1.3421 for USDC and 1.51 for EURC,
labelled as such everywhere, because XSGD exists on no testnet at all. Two
owner-set rates are not an FX engine and I won't call them one. That's why
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

**10. "Any currency in" — how many currencies is that, really?**
Two, and I'd rather give you the number than the adjective: US dollars and euros,
both Circle's own real testnet tokens, both settling to XSGD through the same
`_settle`. Rupees are in the picker and visibly **locked**, because no INR
stablecoin exists on Base Sepolia — shown rather than hidden, so you can see
what's true today and what isn't.

The claim that generalises isn't the count, it's the cost of the third one:
listing EURC took **one owner transaction and no redeploy**, because `rateOf` is
an open mapping and the core holds no token allowlist. And it cost no honesty —
no mock was added. MockXSGD is still the only mocked token in the system, and it
is mocked because XSGD exists on no testnet at all.

One limit worth stating before you find it: an agent wallet spends **one**
currency. Its `Policy` has a single cap and a single spend counter in one token's
units, so a wallet spending both would count €1 as $1 — about 13% adrift, and
silently. Per-token counters mean redeploying all four contracts, so the rule is
enforced at the door instead, with its own refusal code.

**11. Where does the euro actually cost you more?**
Nowhere, and that's measurable rather than asserted: 181,676 gas for a euro
settle against 181,676 for a dollar one on the `exact` door, and 267,408 against
267,416 end to end. Same contract call with a different `tokenIn`.

The one honest wrinkle is in `docs/measurements.md`: the very first euro payment
cost 197,356, about 7% more. That was cold storage for a token the contracts had
never touched — repeated warm it's 183,692. We kept the outlier in the doc rather
than quietly dropping it, because the first transaction against a newly listed
token is not a sample of what that token costs.

**12. What are you weakest at?**
Three things, and none of them is a surprise to us. **The merchant back-office is
unauthenticated** — anyone with the URL can read a shop's takings, and we did not
invent a login we couldn't secure in the time. **The demo payer is one shared
account**, so on the deployed build every visitor signs as the same key and the
history is not private; the app says so on two screens. And **a denial record is
relayer-attested** — the verifier re-derives the policy half from public state
and cannot check the signature, so it proves the wallet would have refused, not
that the agent asked.

The one I'd fix next with more time is the bridge's compensation path: the single
place we briefly hold someone else's funds has no automated coverage. It's in the
gaps list in `CLAUDE.md`, not hidden.

### Rapid-fire spares

- *Why XSGD and not USDC to the merchant?* A hawker prices in dollars and pays
  rent in dollars. FX risk is exactly what a merchant shouldn't hold.
- *Why Base?* Cheap L2, real Circle USDC **and EURC** with faucets on testnet,
  and it's where x402 tooling actually runs.
- *Did you write the x402 client?* No — that's the point. We wrote the server
  and the facilitator; the client is `@x402/fetch`, unmodified. It takes
  `accepts[0]` without choosing, which is exactly why the dollar offer is first.
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
- *How many tests?* 538 — 201 Foundry, 170 shared, 163 backend, 4 agent. Five of
  the Foundry ones are fork tests that skip without a fork RPC, so CI runs 196 of
  the 201; don't let a slide imply otherwise. Four are invariants, not unit
  tests. `packages/web` has no suite at all.
- *Solo project?* Yes. Solo student entry, NTU.
