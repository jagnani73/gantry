# Sprint test plan — `f4c5c91` → `487e002`

Manual regression pass over the 74 commits landed 17–20 Aug 2026: multi-currency,
the dual-door pay link, discovery, the denial remedy loop, the AIsa provider, the
merchant honesty fixes, and the contract invariants.

**This file is a log, not just a checklist.** Record the result beside each step
as you go, and open a numbered finding for anything that fails. A step with a
blank result has NOT been run — leaving it blank is the honest state, and
filling it in from memory is how a red run reads as green.

**Status legend:** `—` not run · `PASS` · `FAIL → F#` · `N/A` (needs hardware or
an account nobody here has, see [Cannot be run here](#cannot-be-run-here)).

**Preconditions for every phase:** local backend + web running, `pnpm demo:reset`
green, and the relayer NOT carrying an EIP-7702 delegation (`eth_getCode` on
`0x8251…C47B` must answer `0x`). Phases 2–11 assume Phase 1 passed.

## What needs a human right now

Kept at the top because it is the question this file gets asked, and answering it
from the tables means reading all of them. Current as of 20 Aug, after the F16/F17
pass.

**Nothing is blocking.** The three unverified fixes were driven by the owner and
pass (**25l**, **25m**, **25n** — the last being the originally reported bug), and
the two open decisions have been made and implemented.

**One gap left in what shipped.** **F17**'s partial-drop case: `?sgd=4,50` — a
comma, which is what a European keyboard or a locale-formatted price produces —
opens the right shop with a **blank keypad**, and nothing says an amount was
dropped. The merchant said the link carried the price; the customer sees none. The
whole-overlay case now toasts, but naming a dropped FIELD needs a reason carried
out of the parser, which the shallow `namesAnOverlay` check deliberately does not
do.

**Environmental, worth knowing before a rehearsal.** **F19** — the in-app scanner
cannot decode a QR on the demo machine (`BarcodeDetector` is absent in that
Chrome). Not a defect; the camera runs and the handle field underneath is the way
through, and a phone's own camera app opening `/pay/<handle>` is unaffected. Do
not discover it on stage.

**One fix awaiting your re-test.** **F21** — the agents list rendered a name the
payer had just replaced as fact, beside the new caps and categories. Fixed 20 Aug
(`settleAgentExpectation` now carries the summary that settled it, so the guard
and the data move in one update) but **unverified**: the half-fresh response
cannot be forced from here, so **#50 has to be re-run**. Contained either way —
renaming an agent is in no demo beat.

**Needs hardware or an account.** **U1** (passkey onboarding) and **U2** (merchant
payout rotation from a connected wallet) — see [Cannot be run here](#cannot-be-run-here).

**Not yet driven at all:** Phases 8-11. Phases 4-6 are complete; Phase 7 is in
progress, stopped at #50 on F21.

## Findings register

| #      | Finding                                                                                                                                                                                                                                                                                                                                                                                 | Where                                                 | Status                                                                                                                                                                                                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1** | The sign-off gate's denial line was missing `--handle gadgethub-sg --sgd 4`. `--expect-denial` asserts an outcome, it does not choose the shop — its defaults are `ah-hock-chicken-rice` / S$4.50, a `food_beverage` shop the policy ALLOWS, so the flagless form can never pass.                                                                                                       | `CLAUDE.md` gate block                                | **Resolved** 20 Aug — line corrected, and a paragraph added explaining why both flags are load-bearing.                                                                                                                                   |
| **F2** | The two `e2e:pbm` lines run in sequence against one wallet. The happy path spends 3.352955 USDC, and the facilitator's balance pre-check runs BEFORE the on-chain category check — so a denial priced above what is left dies as `insufficient_funds`, the wrong story. `demo:reset` tops the wallet to 10 USDC but sits at the END of the gate.                                        | gate ordering                                         | **Documented** 20 Aug — recorded in `CLAUDE.md` beside the gate. Not reordered: the S$4 cable clears where S$4.50 would not, which is why the beat is priced that way. Run `demo:reset` first if the wallet is low.                       |
| **F3** | `demo-reset` reset everything about the agent — caps, categories, expiry, `spentToday`, balance — except the label, so a wallet renamed during a browser test kept that name through every reset afterwards. Found live: the demo wallet was reading `"Headphone subscription"` while the demo script and its troubleshooting table both name `"Kopi Runner"`.                          | `scripts/demo-reset.mjs`                              | **Resolved** 20 Aug — step 6c renames an existing wallet when the name differs. Conditional, so the usual run sends nothing; reported but never `degraded`, since a misnamed wallet still settles correctly. Both branches verified live. |
| **F4** | The agents LIST has no give-up path for its freshness gate. `settleAgentExpectation` is called only from `agent-detail.tsx`; the list reads the expectation but cannot clear it. The detail screen bounds its wait at `FRESHNESS_ATTEMPTS` and then says so — the list just renders `Saving…` indefinitely. Self-heals when the read catches up, so it needs a lagging backend to show. | `packages/web/src/components/payer/screen-agents.tsx` | **Open — unverified.** Probe is Phase 7 #53.                                                                                                                                                                                          |
| **F5** | **A wrong exchange rate is rendered on a currency switch.** Neither `rate` nor `balance` is cleared when `sendTokenAddress` changes — both are set only on a successful read — so USD → EUR shows `1 EURC = 1.3421 XSGD` (USDC's rate) and the USDC balance labelled EURC until the round-trip lands. `rate` is the store value EVERY S$ figure in the app converts at, so the window is not confined to Settings; it is ~12.5% adrift at 1.3421 vs 1.5100. Breaks the rule the agents list, the agent detail screen and the payout rotation all follow: known-stale data is not rendered as fact. | `payer-context.tsx` balance + rate effects | **Resolved** 20 Aug — both reads are now STAMPED with the token they answered for, so a read of the previous token is unreadable by construction rather than cleared by an effect. Measured after: the rate row goes `EURC 1.5100` → blank skeleton (12ms) → `USDC 1.3421` (545ms), with no frame stating a wrong pair. Before, that 533ms window read `1 USDC = 1.5100 XSGD`. |
| **F6** | The currency picker paints a selection before it knows one. `payCurrencyCode` starts at `"USD"` on both sides of hydration and the stored value arrives in an effect, so a euro payer sees the selection jump USD → EUR on every load. `payCurrencyReady` already exists and gates the two chain reads, but is not exposed on the store, so the picker cannot gate on it. Same class as the signer `ready` bug already fixed one card above it. | `payer-context.tsx`, `screen-settings.tsx` | **Resolved** 20 Aug — `payCurrencyReady` is exposed on the store and the picker paints no selection until it is true. Measured after via a same-origin iframe boot with EUR stored: transitions are `[]` → `[EUR]`, no USD frame. |
| **F7** | *Enhancement.* The currency picker reads packed — three `h-13` tiles, each carrying a sub-label that duplicates the sentence directly beneath the card. | `screen-settings.tsx` | **Resolved** 20 Aug — one segmented row, sub-labels dropped (they restated the sentence under the card). Extracted as a single `CurrencyPicker` shared with the wallet popover. |
| **F8** | *Enhancement.* No currency control on the payer's home screen, where the balance it governs actually lives — changing currency means a trip to Settings. | `screen-wallet.tsx` | **Resolved** 20 Aug — a currency pill in the balance card header opens an inline popover carrying the same picker. Built as a full-screen overlay first and rejected as the wrong weight for a three-way choice. Verified: opens on click; closes on selection, Esc (focus returns to the pill) and an outside pointerdown; a locked option keeps it open so its toast is readable in place. Width clamps to the viewport — 288px at 360/390/430, 264px at 320 — with no horizontal page scroll at any width. Pill, balance, S$ figure and rate line all agree after a switch. |
| **F9** | `gantry.displayCurrency` is a dead localStorage key — nothing reads or writes it. A leftover from the deleted `PriceReference` feature, still holding stale values in real browsers (`inr` observed). Harmless while unread, but it sits beside a live key of nearly the same name and INR is not payable, which is the exact confusion the rename was made to prevent. | payer app boot | **Resolved** 20 Aug — removed at boot beside the read of the live key. Verified: a planted `inr` value is gone after a fresh boot. |
| **F10** | **Back/Forward across a route closed the overlay the URL named — and deleted the param.** The pathname effect could not tell a tab tap from a popstate restoring an overlay URL, so Back out of `/app/activity?receipt=…` → `/app/agents` ran the popstate listener (restoring the receipt), then the pathname effect (clearing it), then the write-back — which saw an empty stack against a non-empty `lastSyncedRef` and **replaced the `?receipt=` away**. Back landed on a bare tab and destroyed the link. Same for `?agent=`, `?pay=`, `?shop=`, and for Forward. | `payer-context.tsx` | **Resolved** 20 Aug — a `poppedRef` flag set by the popstate listener makes the pathname effect skip its clear for a history navigation. The first attempt re-read `window.location.search` instead and was WRONG: that effect runs before Next commits the new location for a `<Link>` push, so it read the outgoing query and the write-back pushed a SECOND history entry — measured, a tab tap took `history.length` 39 → 41 and Back landed back where it started. Re-measured after: 42 → 43, Back restores `?receipt=` and renders the receipt, Forward returns. |
| **F11** | **`demo-reset` step 6c renamed a wallet because a chain read FAILED.** `toAgentSummary` substitutes `label: ""` when the `label()` call fails, and its own comment says the degraded value "COLLIDES with real ones" and "the substitution is invisible in the response". Step 6c read that sentinel as "nobody named it" and signed `setLabel` **with the payer's key**. One multicall blip on the rate-limited public node would overwrite a payer's own name for their agent and report it as `renamed from ""`. The null guard written to prevent exactly this was unreachable, because `label` is always a string on the wire. | `scripts/demo-reset.mjs` | **Resolved** 20 Aug — 6c reads `label()` off the chain directly, where a failure throws instead of impersonating an empty name, and an unreadable name is announced rather than silently skipped. Found by two reviewers independently. |
| **F12** | **"That payment isn't in this wallet's history" was asserted after the history fetch FAILED.** The settlements catch does `setSettlements([])` — the sentinel collapse the `agents` field's own doc forbids twelve lines above it — and `historyKnown` read `settlements !== null` as "the history answered". A payer following a shared `?receipt=` link during a backend blip got a verdict about the chain derived from a request that never came back. | `payer-context.tsx`, `receipt.tsx` | **Resolved** 20 Aug — `historyKnown` now requires `settlementsError === null`, and `PendingReceipt` gained a third status, `unavailable`, with its own headline ("We couldn't finish reading this wallet's history") rather than a caveat three paragraphs under a headline that had already said the opposite. Found by two reviewers independently. Fixing the `[]` collapse at source was deliberately NOT done — three screens read `settlements` and this is the wrong week to change what null means to them. |
| **F13** | **The new rate skeleton shimmered forever when nothing was being read.** Both chain effects gate on `!address`, so choosing "my own wallet" and connecting nothing left `rate` and `rateError` both null — which the F5 placeholder renders as an animated skeleton, i.e. an active claim that data is on its way. Reachable in one action, no network fault needed. The previous code rendered nothing, which claims nothing, so F5 made this *louder*. | `payer-context.tsx` | **Resolved** 20 Aug — the rate read no longer gates on `address`. The rate is a property of the swap, not of a payer. |
| **F14** | **The settings card stated the pay token in words before the preference resolved.** F6 gated the picker but not the two lines that make the same claim in prose, so a euro payer's first frame read "You sign an authorization for USDC" and "You pay in USDC" **beside a picker deliberately showing no selection** — the two halves of one card disagreeing, on the screen whose job is to say which token signs. Arguably a worse frame than the jump F6 removed. | `screen-settings.tsx` | **Resolved** 20 Aug — both gated on `payCurrencyReady`, same treatment as the rate row below them. |
| **F15** | `OverlayHost`'s switch had no `default` **and no annotated return type**, so a new `Overlay` member returned `undefined`, which React's `ReactNode` accepts. The overlay would push onto the stack, write its query, and render nothing — a payer on the wallet screen with a URL naming a screen that is not there and a Back button that appears dead. `overlayToQuery` has this enforcement; its render half did not. | `payer-frame.tsx` | **Resolved** 20 Aug — return type annotated `ReactElement | null`, so a missing case is the same TS2366 the serializer already relies on. Verified by a reviewer who added a probe member and confirmed the serializer errors; the render half did not. |
| **F16** | **`?agent=` and `?edit=` open ANY well-formed address with no ownership check.** Shape is validated correctly (`isAddress` strict, never `getAddress`), but nothing establishes the wallet is the payer's. `/app?agent=0x…` renders a stranger's caps, bitmap, `spentToday` and balance with Revoke and Withdraw buttons; `/app?edit=0x…&allow=2` opens an editable policy form. Writes revert (`onlyOwner`) so nothing is lost, but this is the screen whose whole job is stating whose rules these are. Sharper on a deployed build, where every visitor shares one demo key. | `overlay-url.ts`, `agent-detail.tsx` | **Resolved** 20 Aug — the CONTROLS are gated, not the route. A policy is public chain state, so refusing to display it protects nothing; what was wrong was dressing it as the payer's and offering buttons. `agent.owner` was already read and printed on the screen and `identity.address` was already in the store, so this needed no ownership lookup and no deferred-open path — which is what made the rejected alternative expensive. Detail screen: Edit/Revoke/Withdraw replaced by a line naming the real owner, policy still shown. The FORM refuses outright, since a form is nothing but its controls. Verified both ways in a browser: owned → three controls, no banner; not owned → no controls, banner, policy still visible, and `?edit=` refused. |
| **F17** | **A malformed overlay param opens nothing and says nothing.** `?pay=<bad handle>`, `?agent=<bad address>`, `?edit=<junk>` all resolve to no overlay and drop the payer on a bare tab with no indication a link was followed and refused. Worse for partial drops, where the overlay DOES open: `?sgd=4,50` (a comma) opens the pay flow on a blank keypad, and `?allow=<junk>` opens the denial-remedy form with nothing pre-ticked — so a payer taps Save, signs, pays gas and changes nothing. | `overlay-url.ts` | **Partly resolved** 20 Aug — a link that NAMES an overlay and opens none now raises a toast: "That link couldn't be opened. Scan the shop's code, or search for it." `namesAnOverlay` is deliberately shallow (was something asked for, not what was wrong with it), which avoids the `rejected` type rework. Raised from a child of `ToastProvider` because the provider that detects it is mounted outside. Verified with `?pay=Ah_Hock_Not_A_Handle`. **STILL OPEN:** the partial-drop case — `?sgd=4,50` opens the right shop with a blank keypad, and nothing says an amount was dropped. That needs the per-field reason the shallow check does not carry. |
| **F18** | The payer app's 14 Basescan links carried no external-link indicator, while the merchant, landing, directory and onboard surfaces all append `↗` — one app, two conventions. | payer surfaces | **Resolved** 20 Aug — 8 link sites now carry it, each wrapped in `aria-hidden` so a screen reader does not announce "north east arrow" as part of the link name (a reviewer caught that the first pass had not). |
| **F19** | `BarcodeDetector` is unavailable in the demo Chrome, so the in-app scanner runs the camera and decodes nothing. `scan.tsx` documents this as a designed degraded path and the handle field underneath is the way through — but the consequence is that **the in-app scanner cannot read a QR code on this machine**, which is worth knowing before a rehearsal. The phone's own camera app opening `/pay/<handle>` is unaffected, and CLAUDE.md already names that as the stage path. | `scan.tsx` (no code change) | **Open — environmental, not a defect.** Recorded because it was discovered live during Phase 3b and would otherwise be re-discovered as a bug on stage. |
| **F20** | **The Copy button never reverted.** The reset was keyed on the copied string changing, which HID the bug rather than fixing it: the merchant charge card's link changes whenever the amount is retyped, so copying the same string twice was the case nobody hit. On the shop page's machine-door card the URL never changes, so "Copied" stayed up for the rest of the session and a second tap gave no feedback at all. | `machine-door.tsx`, `charge-card.tsx` | **Resolved** 20 Aug — a 2s timer on success, cleared on unmount. Deliberately NO timer on the failure branch: a confirmation is an event and is safe to miss, but "Select it" is a CONDITION that holds on the next tap too, so reverting would invite a tap that cannot work. Found by the owner. |
| **F21** | **The agents LIST rendered a name the payer had just replaced, as fact, beside the new caps and categories** — no `Saving…`, no caveat. Exactly the state `isSuperseded`'s own comment describes ("categories updated, the rename apparently ignored"). Two defects compose. (1) `GET /api/agents` fires SIX independent multicalls under one `Promise.all` with **no pinned `blockNumber`**, over the RPC fallback chain — so the policy batch can see a write the label batch has not, and one response carries two block heights with nothing in it saying so. (2) The detail screen reads `api.agent(wallet)` into **component-local** `useState` (`setFresh`) and then calls the **store-wide** `settleAgentExpectation(wallet)` — clearing the list's freshness guard on evidence the list does not hold. The store's `agents` array is never updated by that poll, so the list loses its guard while still holding the stale half. The guard's own exit path reintroduces the bug the guard was written for. | `backend/src/services/agents.ts`, `payer/agent-detail.tsx`, `payer-context.tsx` | **Fixed 20 Aug, UNVERIFIED — re-test is #50.** `settleAgentExpectation(wallet, settledBy?)` now replaces that wallet's row in `agents` in the SAME update that clears the flag, so the guard and the data cannot be cleared apart. The summary is passed only on the branch where the read MATCHED the fingerprint; the give-up branch still settles bare, because promoting a read we have just declared stale would have the list assert it with none of the caveat the detail screen shows. `tsc` + `lint` clean; the half-fresh response cannot be forced from here, so this is verified by re-running #50, not by me. Distinct from F4 and opposite in shape: F4 is *the list can never give up*, this is *the list gives up on someone else's evidence*. |

**F10–F18 came from a four-agent review** (general code, silent failures, comment accuracy, type design) run over the uncommitted tree on 20 Aug. Two findings were reported independently by two reviewers — F11 and F12 — which is the reason both are graded above the rest. Every claim was re-checked against the code before being accepted; F10's first fix was itself wrong and was caught by measuring `history.length` in a browser rather than by reasoning.

---


## Running the commands on this machine

The shell here is **PowerShell**, and every `curl` in this file is written in bash
idiom — which cost three attempts on the first one that used a pipe. `jq` is not
installed either. The translations:

| bash | PowerShell |
| ---- | ---------- |
| a trailing `\` to continue a line | a trailing backtick, or just put it on one line |
| `-o /dev/null` | `-o NUL` |
| `\| grep -i foo` | `\| Select-String -Pattern "foo"` |
| `\| jq` | `\| python -m json.tool` |
| `curl` | `curl.exe` when a flag collides with the PowerShell alias |

The Bash tool is also available and takes the bash forms unchanged, so the other
option is to run them there rather than translating.

## Phase 1 — the CLI sign-off gate

Ten chain-touching regressions, no offline suite covers them. **Check exit codes,
never output** — piping to `tail` masks a failure.

| #   | Command                                                                                | Expected                                               | Result                                                         |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| 1   | `pnpm --filter @gantry/backend e2e:pay`                                                | human door settles, replay check 409                   | **PASS** — blk 45716208, `0x9ade018a…`                         |
| 2   | `pnpm --filter @gantry/backend e2e:pay -- --token EURC`                                | 0.993378 EURC @ 1.5100 → 1.500000 XSGD                 | **PASS** — blk 45716212, `0x036c75af…`                         |
| 3   | `pnpm --filter @gantry/backend x402:buy`                                               | unmodified `new x402Client()`, 200                     | **PASS** — `0x1952df81…`, `token: USDC`                        |
| 4   | `pnpm --filter @gantry/backend x402:buy -- --token EURC`                               | selector picks EURC, 200                               | **PASS** — `0x4357f90b…`, `token: EURC`                        |
| 5   | `pnpm --filter @gantry/backend x402:buy -- --link`                                     | dual-door pay link settles                             | **PASS** — `0x2f276b8c…`                                       |
| 6   | `pnpm --filter @gantry/backend x402:buy -- --discover`                                 | lists shops, pays a listing verbatim                   | **PASS** — 3 of 3 shops, 0.745101 USDC, `0x1058b1e1…`          |
| 7   | `pnpm --filter @gantry/agent e2e:pbm`                                                  | agent door settles, payer = the wallet                 | **PASS** — `0xf470850f…`                                       |
| 8   | `pnpm --filter @gantry/agent e2e:pbm -- --handle gadgethub-sg --sgd 4 --expect-denial` | `CategoryNotAllowed(2)` **and** the `/api/denials` row | **PASS** — both halves, exit 0. First attempt failed → **F1**  |
| 9   | `pnpm --filter @gantry/backend verify:denial`                                          | per-dimension table, `VERDICT: CONSISTENT`             | **PASS** — category FAIL / four PASS, signature caveat printed |
| 10  | `pnpm demo:reset`                                                                      | under 30s                                              | **PASS** — 5.3s                                                |

Step 6's `--discover` proves the loop with no human and no hardcoded handle;
step 3 must stay literally `new x402Client()` with no selector, or the interop
claim is not what it says.

---

## Phase 2 — payer currency picker (`/app/settings`)

| #   | What                                                       | Expected                                                                                                                                                          | Result |
| --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 11  | Load at a 375px viewport                                   | No layout jump — watch the currency picker specifically. A `min-h` was tried and measured failing at 87px; the block reserves space by rendering itself invisibly | **PASS** — no shift reported |
| 12  | The options offered                                        | USD + EUR live, INR locked, **SGD absent entirely**                                                                                                               | **PASS** |
| 13  | Tap INR                                                    | "coming soon" toast, control stays tab-focusable (`aria-disabled`, not `disabled`)                                                                                | **PASS** |
| 14  | Pick EUR                                                   | "You pay in EURC", rate ≈ 1.51, "Shop is paid in XSGD · fixed"                                                                                                    | **FAIL → F5**, now **PASS** — refixed and re-measured: no frame states a wrong token/rate pair |
| 15  | Reload                                                     | Preference survives (`gantry.payCurrency`)                                                                                                                        | **FAIL → F6**, now **PASS** — refixed and re-measured: no USD frame before EUR |
| 16  | With EUR selected, open `/app`                             | Wallet balance reads **EURC**, not USDC. Both chain reads take the token as a dependency — this is the bug exhaustive-deps caught                                 | **PASS** — settles on EURC; see F5 for the window before it does |
| 17  | `localStorage.setItem('gantry.payCurrency','SGD')`, reload | Coerced to USD, no break                                                                                                                                          | **PASS** — also surfaced the dead `gantry.displayCurrency` key → **F9** |

Steps 18-21 cover the controls this pass added (**F7**, **F8**). Re-run them
together with 11-17: the pill and the settings card share one `CurrencyPicker`,
so a change to either is a change to both.

| #   | What | Expected | Result |
| --- | ---- | -------- | ------ |
| 18  | The currency pill on `/app`, before the stored preference resolves | A placeholder, never a currency. The pill has the same failure mode as the segments — anything painted before `payCurrencyReady` is a guess | **PASS** |
| 19  | Open the popover | Anchored under the pill, nothing on the card moves. Depth from a hairline and fill, never a shadow (`--shadow-drawer` is the only shadow in the system) | **PASS** |
| 20  | Dismissal | Closes on selection, on Esc (focus returns to the pill) and on an outside `pointerdown` — capture phase, so a dismissing tap does not also hit "Top up" 60px below. A LOCKED option keeps it open, so its toast is readable in place | **PASS** — all five asserted |
| 21  | Width at 320 / 360 / 390 / 430 | Clamps to the viewport with a 12px gutter and never scrolls the page sideways | **PASS** — 264px at 320 (clamped), 288px above it |

## Phase 3 — pay in euros, in a browser

| #   | What                                | Expected                                                           | Result |
| --- | ----------------------------------- | ------------------------------------------------------------------ | ------ |
| 22  | `/pay/ah-hock-chicken-rice`, S$1.50 | Review card quotes ≈0.99 EURC, rate line names EURC | **PASS on the figure, UNOBSERVED on the copy** — the settlement moved 0.993378 EURC, which is the correct ceiling quote at 1.5100, so the quote was right. Nobody recorded whether the rate line on screen named EURC |
| 23  | Top up                              | Faucet grants EURC **sized for the S$5 cap** (≈3.31), not a flat 4 | **PASS** — balance delta proves it: 4.000000 − 0.993378 + **3.400000** = 6.406622, read off-chain. 3.40 is the per-token grant, not the flat 4 |
| 24  | Sign & pay                          | Settled card, Basescan link, row lands on the merchant feed        | **PASS** — `0xdc2fcf97…`, block 45717884, gas 183,676. Decoded from the receipt rather than taken from the UI: payer `0xacAD…33F5`, tokenIn EURC, 0.993378 in → 1.500000 XSGD, fee 0.007500, net 1.492500, door `human` |
| 25  | Switch to USD, pay again            | ≈1.117652 USDC, both rows on one book                              | — **not run.** Payer USDC is unchanged at 86.503834 |

## Phase 3b — URL-addressable overlays

The largest change in the sprint shipped with no steps in this file, which is how
its two worst defects (**F10**, **F15**) reached a review rather than a test. These
are the cases that were actually driven; the numbering is a letter because Phases
4-11 are cross-referenced by number elsewhere in this file.

| #    | What | Expected | Result |
| ---- | ---- | -------- | ------ |
| 25a  | Open the scanner | URL becomes `?scan=1` | **PASS** |
| 25b  | Close it | `/app`, and **no** new history entry (close REPLACES) | **PASS** |
| 25c  | Reopen | `?scan=1` back, history grew by one (open PUSHES) | **PASS** |
| 25d  | Press Back | Overlay closes, still inside `/app` | **PASS** |
| 25e  | **Cold load `/app?scan=1`** | Scanner opens from the URL alone | **PASS** — camera live, 640×480 |
| 25f  | Open a receipt from Activity | `?receipt=<txHash>:<logIndex>` | **PASS** |
| 25g  | Tab away to Agents | One history entry added, not two | **PASS** — 42 → 43. Was 39 → 41 before **F10**'s second fix |
| 25h  | **Press Back** | Returns to `/app/activity?receipt=…` **and renders the receipt** | **PASS** — param survived, overlay restored |
| 25i  | Press Forward | Returns to `/app/agents` | **PASS** |
| 25j  | Junk params — `?shop=not a handle`, `?agent=0xdeadbeef`, a wrong-checksum address, `?edit=junk`, `?scan=0` | Each opens nothing; the URL is not rewritten | **PASS** (driven by the implementing agent, not re-checked here) |
| 25k  | `?receipt=<key not in history>` | The "not in this wallet" screen, with the key echoed | **PASS** (fabricated key) |
| 25l  | `?receipt=` while the history request FAILS | The **`unavailable`** screen — never "not in this wallet" | **PASS** — driven by the owner, 20 Aug |
| 25m  | `?edit=0x…&allow=7` (unlisted category) | Nothing pre-ticked, and nothing added to the signed bitmap | **PASS** — driven by the owner, 20 Aug |
| 25n  | `/pay/:handle` → close | Lands on `/app`; a refresh does not reopen the payment | **PASS** — driven by the owner, 20 Aug. This was the originally reported bug |

## Phase 4 — the charge link

| #   | What                                                   | Expected                                                                                                                          | Result |
| --- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 26  | `/merchant/ah-hock-chicken-rice/qr` standee copy       | Must NOT claim it is the x402 door — it names a shop and never a price                                                            | **PASS** — owner |
| 27  | Type `1.5` in Charge an amount                         | Prose reads **S$1.50**                                                                                                            | **PASS** — owner |
| 28  | Type `50000`                                           | **S$50000.00** — no thousands separator, deliberately                                                                             | **PASS** — owner |
| 29  | Type `1.234` / `abc`                                   | Shape error, no QR                                                                                                                | **PASS** — owner |
| 30  | Copy the link                                          | Points at the **backend** origin, not the payer app                                                                               | **PASS** — owner |
| 31  | Open it in a browser                                   | Payer page with the pad **prefilled**                                                                                             | **PASS** — owner |
| 32  | `curl -i -H 'Accept: application/json' "<link>"`       | **402** with `PAYMENT-REQUIRED`                                                                                                   | **PASS** — `402` + `PAYMENT-REQUIRED`; decoded offers are `exact/USDC · exact/EURC · gantry-pbm/USDC · gantry-pbm/EURC`, so `exact/USDC` is accepts[0] as the boot assert requires |
| 33  | `curl -i "<link>"` (bare `*/*`, what curl sends)       | **402**, not a redirect. `req.accepts()` would answer html here and silently close the machine door with every test still passing | **PASS** — `402`, not a redirect, with curl's bare `Accept: */*` |
| 34  | `curl -i -H 'Accept: text/html' -H 'X-Forwarded-Host: evil.example' "<link>"` `Accept: text/html` is MANDATORY — without it the request takes the 402 branch and proves nothing about the redirect | Must NOT redirect to evil.example                                                                                                 | **PASS** — `500 PayLinkNotConfigured` ("this host cannot resolve the payer app; set APP_URL"), and zero occurrences of `evil.example` in the response. Control without the header: `302 → http://localhost:3000/pay/…?sgd=4.50`. Live test locally: `trust proxy` is 1 so the header IS honoured, and `APP_URL` is unset so derivation is the path exercised |
| 35  | `?sgd=1&sgd=2`                                         | Pad starts empty — two prices in a link is a broken link                                                                          | **PASS** — the backend drops the ambiguous amount (`302` with no `?sgd=` at all) and the web half was driven by the owner: the pad opens empty. Two guards, not one |

## Phase 5 — the machine door on a shop page

| #   | What                      | Expected                                                                                      | Result |
| --- | ------------------------- | --------------------------------------------------------------------------------------------- | ------ |
| 36  | `/m/ah-hock-chicken-rice` | Fetches a live 402, labelled "asked just now"                                                 | **PASS** — owner. Two UI changes came out of it: a Copy button on the curl command, and the offers grouped into a table instead of four repeated sentences |
| 37  | The offers listed         | Four rows: `exact · USDC`, `exact · EURC`, `gantry-pbm · USDC`, `gantry-pbm · EURC`           | **PASS** — owner |
| 38  | Each row's ticker         | Taken from the challenge — a euro row rendering "USDC" is the bug this was fixed for          | **PASS** — owner |
| 39  | Ordering                  | `exact · USDC` **first** (boot assert; vanilla clients take `accepts[0]`)                     | **PASS** — owner. Re-confirmed from the header decoded in step 32: `exact/USDC` is `accepts[0]` |
| 40  | Stop the backend, reload  | Says the live check did not answer, shows the curl command alone. Never an invented challenge | **PASS** — owner |

| 40a | Tap **Copy** on the curl command, twice | Label goes `Copy` → `Copied` → back to `Copy` after ~2s, and the second tap gives feedback too | — **needs a human.** `navigator.clipboard.writeText` requires a real user gesture, which an automated click does not grant, so a scripted run can only ever exercise the failure branch |
| 40b | The same button where the clipboard is unavailable (plain http over a LAN) | Reads **Select it** and STAYS there | **PASS** — a synthetic click reproduces exactly this, and the label persisted past 3s as intended |

**F20 was found here.** The Copy button never reset: this URL never changes, so
"Copied" was the label for the rest of the session and a second tap gave no
feedback at all — indistinguishable from a button that had stopped responding.
The merchant's charge card carried the same defect, hidden because its reset is
keyed on the link and retyping an amount happens to clear it; copying the same
link twice was the case nobody hit. Both now revert on a timer. The FAILURE
state deliberately does not: a confirmation is an event and is safe to miss,
while an unavailable clipboard is a condition that holds on the next tap too,
so reverting would invite a tap that cannot work and take the instruction with
it.

## Phase 6 — discovery

| #   | What                                                                      | Expected                                                                                   | Result |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------ |
| 41  | `curl -s localhost:4000/discovery/resources \| jq`                        | Every merchant, each with its own `?sgd=1.00` and a real quote (745101 USDC / 662252 EURC) | **PASS** — 3 merchants, each carrying its own `?sgd=1.00` and the real quote (745101 USDC / 662252 EURC), plus `serviceName`, `description`, `tags` and `lastUpdated`. `indexer.lag` 0 |
| 42  | `?limit=1&offset=1`                                                       | Paging works; `pagination.total` is the registry's count, not the page length — it is NESTED, which is the Bazaar shape                         | **PASS** — `limit=1&offset=1` returns exactly one item (`gadgethub-sg`, the second) and `pagination` reads `{limit:1, offset:1, total:3}`: the registry's count, not the page length |
| 43  | Compare a listing's `accepts[]` to the challenge its `resource` points at | Same set, same order — these drifted for one commit                                        | **PASS** — identical as a SET and in ORDER. Listing and challenge both read `exact/USDC@745101 · exact/EURC@662252 · gantry-pbm/USDC@745101 · gantry-pbm/EURC@662252`. Order matters as much as membership: these drifted for one commit when only `exact` learned to fan out |
| 44  | Response headers                                                          | `Cache-Control: no-store`                                                                  | **PASS** — `Cache-Control: no-store` |

## Phase 7 — agents (payer app)

| #   | What                                                                                                                                                           | Expected                                                                                                            | Result |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------ |
| 45  | `/app/agents`                                                                                                                                                  | Each agent's caps named in **its own token**                                                                        | **PASS** — Kopi Runner reads `Caps are stored in USDC … 1 USDC = 1.3421 XSGD`, Euro Runner `EURC … 1.5100`. Both list rows show S$50.00, which is the point: same S$, different token underneath |
| 46  | With a USDC and a EURC agent both present                                                                                                                      | Copy reads "each agent's own token" rather than naming one                                                          | **PASS** — "Caps are stored in each agent's own token." |
| 47  | Open an agent                                                                                                                                                  | **"Turned away"** beside "Allowed at", with the line saying it can only account for the categories this build knows | **PASS** — `Food & Beverage` accent, `Electronics · Retail · Transport` neutral |
| 48  | The line under that card                                                                                                                                       | States a category is what KIND of shop, never WHICH one                                                             | **PASS** |
| 49  | Change name + categories together                                                                                                                              | Three transactions in order; toast reads "All changes saved on-chain."                                              | **PASS** — three prompts in order (policy → signer → name), all mined. Run on a throwaway `Scratch` agent, NOT the demo pair: `demo-reset` finds the demo wallet by `agentSigner`, so rotating that would make the next reset DEPLOY a second wallet. **The demo key gives no prompts** — it signs locally in-process — so this needs the connected-wallet path |
| 50  | While that read catches up                                                                                                                                     | List row shows **"Saving…"**, never the new categories beside the old name                                          | **FAIL → F21**, fix landed, **MUST BE RE-RUN.** The list showed the OLD name beside the NEW categories and caps, as fact, with no `Saving…` — exactly the state `isSuperseded`'s own comment describes. Reload cleared it; navigating back to the list did not. Re-run: rename + change categories, save, return to the list, and the name must be the new one (or `Saving…`) — never the old one |
| 51  | Reject the **second** wallet prompt                                                                                                                            | Partial-save toast names specifically which write landed                                                            | —      |
| 52  | Revoke                                                                                                                                                         | Chip flips to Revoked with no stale "Active"                                                                        | —      |
| 53  | **F4 probe:** save from a denial receipt (which opens the form directly, bypassing the detail screen), then go to `/app/agents` against a cold/lagging backend | Does the row clear from "Saving…", or sit there with nothing explaining why?                                        | —      |

## Phase 8 — denial → remedy

| #   | What                                              | Expected                                                                                                                        | Result |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 54  | Open the denial receipt in the payer app          | `CategoryNotAllowed` **verbatim**, "Moved: Nothing", cancel tx shown                                                            | —      |
| 55  | Below it                                          | **"Still refused today"** → button reads **"Allow Electronics"** (display label, not the `electronics` slug)                    | —      |
| 56  | Tap it                                            | Policy form opens with Electronics pre-ticked **on top of what is on-chain**, expiry preserved, Save still requires a signature | —      |
| 57  | Save, reopen the receipt                          | Now reads **"Your rules have changed since"**                                                                                   | —      |
| 58  | Revert the policy                                 | Or the demo denial beat stops denying                                                                                           | —      |
| 59  | View a denial for a wallet the payer does not own | Remedy card renders **nothing**                                                                                                 | —      |

## Phase 9 — the verifier

| #   | What                                      | Expected                                                                                                             | Result                |
| --- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 60  | `verify:denial -- --tx <cancelTxHash>`    | Per-dimension table, `VERDICT: CONSISTENT`, `SIGNATURE_IS_NOT_CHECKED` note every run                                | **PASS** (Phase 1 #9) |
| 61  | Same, against a denial a day or more old  | The historical read returns a DIFFERENT expiry than the wallet has now — that is the proof it is pinned to the block | —                     |
| 62  | With the backend stopped, explicit `--tx` | Works — it asks no Gantry API for an opinion                                                                         | —                     |

## Phase 10 — the agent's LLM path

| #   | What                                                                | Expected                                                               | Result |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------ |
| 63  | `AISA_API_KEY` + `AISA_MODEL=qwen-flash`                            | Live run, tool lines, settlement                                       | —      |
| 64  | Unset `AISA_MODEL`                                                  | One sentence, **exit 2**, no stack, no HTTP                            | —      |
| 65  | `AISA_MODEL` pointed at a paid id                                   | Fails at the first tool call with `recharge_required`, not at startup  | —      |
| 66  | Unset both provider keys                                            | Scripted mode, same beats                                              | —      |
| 67  | `pnpm --filter @gantry/agent test`                                  | Four cases, all against a closed port so nothing can spend             | —      |
| 68  | `pnpm --filter @gantry/agent bench:models qwen-flash qwen3.7-flash` | ttfp against the 8s budget, tool sequence, whether it extracted S$4.50 | —      |

## Phase 11 — merchant surfaces

| #   | What                                   | Expected                                                                                                          | Result |
| --- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------ |
| 69  | `/merchant/<handle>/settings` in dev   | Editable profile; handle + category locked, each with its own reason                                              | —      |
| 70  | Same, built with `NODE_ENV=production` | Every profile field locked, **no submit path at all**; payer preview, payout rotation and chime toggle still work | —      |
| 71  | `/onboard` in dev                      | "permanently" appears once, on the handle tag; name/location/blurb say they can be updated, mechanism is "ask us" | —      |
| 72  | `/onboard` in production               | Form not shipped at all                                                                                           | —      |

---

## Cannot be run here

Not gaps in the plan — jobs needing a device, an account or a key nobody in this
repo has. Recorded so they are neither forgotten nor mistaken for tested.

| #      | What                                             | Why it is blocked                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Result |
| ------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **U1** | Passkey payout creation on `/onboard`            | Needs a device with biometrics. Verified only to _render_ and resolve its connector — no human has ever completed a registration through it. Watch: the wagmi connector id is `baseAccount`, not RainbowKit's `base`; the wrong one leaves a button that silently does nothing, and a cancelled prompt must say nothing at all                                                                                                                                        | N/A    |
| **U2** | Merchant payout rotation from a connected wallet | Gated on `msg.sender == merchant.payout`, so it cannot be rehearsed with the demo key — needs the wallet that actually owns a shop. The least exercised browser write in the product, and after Phase 11 locked settings it is the ONLY write left on a production merchant surface. Also exercises the 60s `getMerchant` TTL trap: a re-read straight after a confirmed receipt returns the OLD payout, and the screen must render `rotatedTo` with a line saying so | N/A    |

## Not in any gate

Reachable from here, but exercised at most once and never automatically.

| #      | What                                      | Command                                                                                                                                                                                                                                                                            | Result                             |
| ------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **U3** | The euro AGENT door                       | `AGENT_PAY_TOKEN=EURC AGENT_WALLET=<euro wallet>` then `e2e:pbm`. Proven once by hand 19 Aug (`0x0013298126…`), reachable only through `demo:seed`. Also test the refusal: point a USDC agent at a EURC quote → must be `agent_currency_mismatch`, not a generic `invalid_payload` | —                                  |
| **U4** | `AGENT_USE_PAY_LINK=1`                    | The agent pays `GET /pay/:handle` — literally the same URL a tourist opens. The demo's strongest single line, off by default, proven once (`0xf0099f0e…`)                                                                                                                          | —                                  |
| **U5** | `verify:denial` with **no** `--tx`        | The documented demo path walks a running backend for the newest denial. Every rehearsal has used `--tx`; its failure branches ("no non-bridged agent-door payment found", "checked N wallets and none has a cancel tx") have never fired                                           | **PASS** (Phase 1 #9 ran flagless) |
| **U6** | `pnpm demo:seed --dry-run`, then for real | Brand new, minutes long, spends real USDC and EURC, provisions a second agent. Has run at most once. `--dry-run` first                                                                                                                                                             | —                                  |

---

## Regression watch-points

Things this sprint made newly fragile, worth a glance whenever the area is touched.

- **`accepts[]` ordering.** Two boot asserts guard it (`exact` first, `VANILLA_DEFAULT_TOKEN` payable), but the fan-out order comes from the key order of the `TOKENS` object — tidying that registry would move every vanilla client onto euros without anyone touching the route. Phase 5 #35 is the cheap check.
- **The freshness gate on the agents list.** See **F4** and **F21**. The invariant F21 established: the flag and the row it guards must be cleared in ONE update. Anything that calls `settleAgentExpectation` from a read the store's `agents` array has not seen must pass that summary, or the list goes unguarded over stale data.
- **`GET /api/agents` can mix block heights.** Six independent multicalls under one `Promise.all`, none pinned to a `blockNumber`, over the RPC fallback chain — so one response can carry a policy and a label read one block apart, with nothing in it saying so. F21's client-side fix stops that surfacing after a write this browser made; it does not make the response internally consistent. Deliberately not pinned: on a fallback chain a block some replica has not seen turns a stale read into a failed one, and `allowFailure: true` would then push those wallets into the "could not be read" notice — a scarier wrong answer than a stale name.
- **A `TOKENS` entry pushed before its token exists on-chain takes production down** — `assertTokenDomains()` live-reads `name()`/`version()` at boot and exits. Deploy the token → `setRate` → _then_ push.
  </content>
  </invoke>
