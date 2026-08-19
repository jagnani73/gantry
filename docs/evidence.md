# Evidence

Five claims on Base Sepolia, each with the transactions behind it, and what each
one is and is not proof of.

`docs/measurements.md` answers *what a payment costs*. This file answers *what
you may conclude from one*. Every row below was read back off-chain with
`eth_getTransactionReceipt` after the fact, not copied out of an application
log, and every claim in the third column is one we would rather state than have
a reader discover.

Contracts, all Basescan-verified and deployed in one run:

| | Address |
|---|---|
| `GantryCore` | [`0xE6289ceA…22cc93`](https://sepolia.basescan.org/address/0xE6289ceA9232af61d7e4F30A67a848c0C322cc93) |
| `FixedRateSwap` | [`0xd84F8C46…11a0d`](https://sepolia.basescan.org/address/0xd84F8C46E7CAEA01188B6e27E8f1a07aD8311a0d) |
| `MockXSGD` | [`0xffebE173…5e3503`](https://sepolia.basescan.org/address/0xffebE1735e22c274Ae30B2fBb3d4e422a75e3503) |
| `AgentPBMWalletFactory` | [`0x9e51484b…7Baac1`](https://sepolia.basescan.org/address/0x9e51484b1B79bB3E9EaCEfB3D3510Cc19b7Baac1) |
| Relayer / owner | [`0x82513007…4FC47B`](https://sepolia.basescan.org/address/0x82513007C7eB93b54dC555Bdb74341b3084FC47B) |

**One thing to know before reading any receipt below.** On this deployment the
demo merchant's payout address *is* the deployer address, so the fee leg and the
merchant leg of a settlement both land on `0x8251…4FC47B`. That is an artifact
of seeding a demo, not the relayer keeping the money — the split is visible in
the logs and the arithmetic is checked below.

---

## 1 · A human pays, over the printed QR

[`0xa237b455…07bbf8`](https://sepolia.basescan.org/tx/0xa237b4557adf988511bc1f27056d3312e6fd39992a86dd9bba082c806507bbf8)
· block 45,607,554 · 2026-08-18 00:16:36 SGT · status `0x1` · 183,676 gas · 10 logs

| | |
|---|---|
| Merchant | `ah-hock-chicken-rice` |
| Payer | `0x9D2D57B8…6b504` |
| In | 1.117652 USDC (Circle's real testnet token) |
| Out | 1,500,000 XSGD gross · 7,500 fee · 1,492,500 to the merchant |
| Called | `settleWithAuthorization` (selector `0x73f7ab75`) |
| `IntentSettled.door` | `0` — human |

**What this proves.** The payer sent no transaction. The `from` on this receipt
is the relayer; the payer's contribution was a signature. The first log is
USDC's own `AuthorizationUsed`, with `authorizer` = the payer and
`nonce` = `0x2dc37d39…8384` — **the same value as the `intentId`**. That
equality is the design's central binding: an EIP-3009 authorization for this
payment cannot be replayed against any other intent, because the nonce *is* the
intent. It is checkable by anyone from this receipt alone.

The quote arithmetic is checkable too, by hand: `1.50 ÷ 1.3421 = 1.1176514…`,
rounded **up** to `1.117652`. The ceiling is deliberate — a quote rounded down
underpays and reverts. The fee is `1,500,000 × 50 ⁄ 10,000 = 7,500`.

**What this does not prove.**

- **Not that the merchant is who it says.** `registerMerchant` is permissionless
  and the profile text is self-attested. Nothing in Gantry reviews a merchant,
  and there is no KYC anywhere in the system. "Registered", never "verified".
- **Not that 1.3421 is a market rate.** It is owner-set on `FixedRateSwap`. The
  `IGantrySwap` interface is where production FX would go; the demo rate is a
  constant we chose.
- **Not that XSGD is real.** `MockXSGD` is the one mocked token in the system,
  and it is unavoidable: XSGD exists on no testnet, only on mainnet via
  StraitsX.
- **Not that this payer is a distinct person.** On the deployed build every
  visitor signs with one shared demo key, so the payer address identifies the
  demo account and not a human.

---

## 2 · An agent pays the same merchant, through the same function

[`0xcb4d2ea1…e19740`](https://sepolia.basescan.org/tx/0xcb4d2ea1cb1bb6ae2044c81d9b5cbf58b297ff2f78094e046ca45f65a7e19740)
· block 45,607,772 · 2026-08-18 00:23:52 SGT · status `0x1` · 181,598 gas · 10 logs

| | |
|---|---|
| Merchant | `ah-hock-chicken-rice` — **the same shop as §1** |
| Payer | `0xd99C11b0…429cBd` — an `AgentPBMWallet`, not a person |
| In | 3.352955 USDC |
| Out | 4,500,000 XSGD gross · 22,500 fee · 4,477,500 to the merchant |
| Called | `settleFromPBM` (selector `0x909ab09a`) |
| `IntentSettled.door` | `1` — agent |

**What this proves.** This is the convergence claim as two receipts rather than
a diagram. Two payers of different kinds, seven minutes apart, one merchant, one
`IntentSettled` event signature, one `_settle`. The gas differs by 1.1% —
183,676 against 181,598 — and the difference is the authorization check in
front of the shared path, not a second rail.

`4.50 ÷ 1.3421 = 3.3529543…` → `3.352955`; fee `4,500,000 × 50 ⁄ 10,000 =
22,500`. The same arithmetic as §1, because it is the same code.

**What this does not prove.**

- **Not that an LLM decided anything.** The model narrates; the signing and the
  HTTP live in tools it cannot reach. A run in which the model timed out and the
  scripted fallback took over produces a byte-identical receipt — deliberately,
  because the money path never depends on the LLM.
- **Not who owns the agent.** The wallet's `owner()` is on-chain; that an
  address corresponds to a particular person is outside the system.
- Everything in §1's list applies here too — same merchant, same rate, same
  mocked settlement token.

---

## 3 · An agent is refused, on-chain

[`0x417b23b7…e0edf0`](https://sepolia.basescan.org/tx/0x417b23b7475cd4dd9de1bcd0e4a6c9b9a2e1c0028ddf114b170e843291e0edf0)
· block 45,606,788 · 2026-08-17 23:51:04 SGT · status **`0x1`** · 35,241 gas · 2 logs

| | |
|---|---|
| Merchant | `gadgethub-sg` (`categoryId` 2, electronics) |
| Wallet | `0xd99C11b0…429cBd` — the same wallet that paid in §2 |
| Attempted | 2.980404 USDC for S$4.00 |
| Called | `cancelIntentWithReason` (selector `0x2c4743e8`) |
| Logs | `IntentCancelled(bytes32)` · `IntentDenied(bytes32,address,bytes)` |
| `reason` bytes | `0x69cab3ea` + `…02` — 36 bytes, verbatim |

**Read the status field again: `0x1`.** A refused payment has no failed
transaction anywhere on Basescan. The policy revert is caught by
simulate-before-send and never broadcast, so the refusal rides on the
cancellation, which succeeds. Anyone looking for a red transaction will not find
one, and that is the design rather than a gap.

**What this proves.** The `reason` is not a string and not an enum — it is the
wallet's raw revert data, passed through untouched. `0x69cab3ea` is the selector
of `CategoryNotAllowed(uint16)` and the argument is `2`. The indexer decodes it
with the same decoder the backend used when it caught the revert, so one
vocabulary runs from the contract to the payer's receipt.

The refusal is checkable against public state at that block, and this is the
part worth doing by hand:

| Read | Value |
|---|---|
| wallet `categoryBitmap()` | `2` → binary `10` → bit 1 set → `food_beverage` (categoryId 1) |
| merchant `gadgethub-sg` `categoryId` | `2` → requires bit 2 → value `4` |
| `2 & 4` | `0` → **not allowed** |

The caps were not the binding constraint, and that is the whole point of pricing
this beat at S$4: `perTxCap` reads 37.255049 USDC (× 1.3421 = S$50.00), so
2.980404 was never close to it, and the wallet is topped up before a run
precisely so the refusal cannot arrive as `insufficient_funds` instead. **The
amount was fine. The category was not** — which is a sharper claim than "it was
blocked", and it is the one the arithmetic above supports.

**What this does not prove — and this is the most important paragraph in this
file.**

**A denial record is relayer-attested, not chain-proven.** `IntentDenied`
carries bytes the relayer supplies. It is *not* reproducible by a third party,
because `authorizeSpend` checks the agent's signature **first**, and that
signature is never stored or emitted — so anyone re-simulating this call gets
`InvalidAgentSignature` whatever the real reason was.

What survives that caveat is the table above: `CategoryNotAllowed` is checkable
against the wallet's bitmap and the merchant's category as public state at that
block, and so are `PerTxCapExceeded` (against `perTxCap` and
`getIntent().amountIn`) and `PolicyExpired` (against `expiry`).
`DailyCapExceeded` needs an archive node for `spentToday()`.
`InsufficientWalletBalance` is not checkable at all.

And the intent stores no wallet, so the wallet↔intent binding in this event is
the relayer's word, bounded only by the guard that refuses to author a denial
against a human-door intent. **The refusal is real. The record does not prove
it.** We would rather write that sentence than let a judge find it.

**You do not have to do that arithmetic by hand, and you do not have to ask us.**

```bash
pnpm --filter @gantry/backend verify:denial -- --tx <cancelTxHash>
```

It takes one cancel transaction — the Basescan link a declined receipt already
shows — reads the policy, `spentToday()`, the wallet balance and the merchant's
`categoryId` **at that block**, recomputes `authorizeSpend`'s decision through
the same `checkSpend` the product uses, and compares it to the reason we emitted.
Every input is a public getter or a log, so a stranger with any RPC URL gets the
same answer; it asks no Gantry API for an opinion.

Three things about it matter more than that it exists:

- **It can contradict us.** The verdict is `consistent` / `contradicted` /
  `unprovable`, and the fabricated-claim case is unit-tested rather than
  asserted. A checker that can only agree proves nothing.
- **It reads history, not head.** Run against a 1.4-day-old denial it returns a
  *different* expiry than that wallet has now, which is how we know the block
  pinning works.
- **It still does not check the signature**, so it proves the wallet *would have
  refused* and never that the agent *asked*. That limit is exported as a constant
  and printed on every run. The wording stays "re-derivable from public state" —
  not "reproducible", and not "chain-proven".

---

## 4 · An unmodified x402 client pays, through the bridge

[`0x5170803d…a0c350`](https://sepolia.basescan.org/tx/0x5170803d0c28f928563eb22b4ef7be78785bceded22cd6421f9426abf7a0c350)
· block 45,599,947 · status `0x1` · 181,676 gas · 10 logs

| | |
|---|---|
| Merchant | `ah-hock-chicken-rice` |
| **On-chain payer** | `0x82513007…4FC47B` — **the relayer** |
| In / out | 3.352955 USDC → 4,500,000 XSGD · 22,500 fee |

**What this proves.** A literally unmodified `@x402/fetch` client paid a Gantry
merchant end to end. That was the bar we set for whether we had implemented a
standard or merely cited one.

**What this does not prove — and it is visible right here in the receipt.** The
buyer's address appears nowhere. `createNonce()` in `@x402/evm` random-generates
the EIP-3009 nonce and offers no way to pin it, while the core requires
`nonce == intentId`; those two facts do not reconcile, so the bridge collects
the agent's authorization onto the relayer and self-signs a second one. The
first log here is `AuthorizationUsed` with `authorizer` = the relayer, which is
the custodial hop made legible. **One hop, PSP-shaped, and on the honest-labels
list.** `docs/measurements.md` prices it: 267,416 gas against 181,582 direct,
about 47% more.

---

## 5 · The same three doors, paid in euros

The claim is *any currency in, Singapore dollars out*. Three receipts, one per
door, all settling to XSGD — and a fourth that shows the custodial hop again.

| Door | Transaction | In | Out |
|---|---|---|---|
| Human QR | [`0x0d2c5eaf…`](https://sepolia.basescan.org/tx/0x0d2c5eaf7b5a6010ad03b28155b80fb814967c674583601d48f9cac0824b373f) · block 45,671,552 · 19 Aug 11:49:52 SGT · 197,356 gas | 0.993378 EURC | 1,500,000 XSGD · 7,500 fee · 1,492,500 to the merchant |
| Agent PBM | [`0x00132981…`](https://sepolia.basescan.org/tx/0x0013298126ebea3136db415559bf43299ec9f78dbac16ea25a48dbf837536f7f) · block 45,674,352 · 19 Aug 13:23:12 SGT · 181,582 gas | 2.980133 EURC | 4,500,000 XSGD · 22,500 fee · 4,477,500 to the merchant |
| x402 `exact` | [`0x26db5566…`](https://sepolia.basescan.org/tx/0x26db556614fef6ea9f2d91a809c77a2bae26cf955d6821b8a668965e51e130c3) · block 45,677,314 · 19 Aug 15:01:56 SGT · 181,676 gas | 2.980133 EURC | 4,500,000 XSGD · 22,500 fee · 4,477,500 to the merchant |

**What this proves.** The euro is not a label on a dollar payment. Each receipt's
first token movement is Circle's own EURC
([`0x80845665…77359F`](https://sepolia.basescan.org/address/0x808456652fdb597867f38412077A9182bf77359F)),
leaving the payer, entering `GantryCore`, passing through `FixedRateSwap`, and
coming back as XSGD before the fee split — the same five-transfer shape as every
dollar payment in §1–§4, because it is the same `_settle`.

**No mock was added to do this.** EURC is a real Circle FiatToken v2 with a
`TRANSFER_WITH_AUTHORIZATION` typehash byte-identical to USDC's, which is why the
signing path needed no second branch. `MockXSGD` is still the only mocked token
in the system, and that sentence is load-bearing.

**Listing it cost one owner transaction and no redeploy.**
[`0x6aded10d…`](https://sepolia.basescan.org/tx/0x6aded10d2859de33d5aa243ad651b8d2b825cc4ea6295042c37598a3e473700a)
set `rateOf(EURC) = 1_510_000`. `rateOf` is an open mapping and `GantryCore`
holds no token allowlist, so the `IGantrySwap` seam the design claimed turned out
to be real rather than aspirational.

**The `exact` row has a second transaction, and it is where the buyer is.**
[`0xc3b43203…`](https://sepolia.basescan.org/tx/0xc3b4320394daa6c2ff8fa777abeb77415fa5afdaf939e3059721c9a52b8a5df0)
· 85,732 gas · the collect leg, in the **same block** as the settle. Its
`AuthorizationUsed.authorizer` is `0x681ecfd5…63bc9`, the actual payer; the
settle's is the relayer. Same custodial hop as §4, same honest label — the
currency changed and the trust model did not.

**What this does not prove.**

- **Not that 1.51 is a market rate.** It is owner-set, exactly as 1.3421 is. Two
  owner-set rates are not an FX engine.
- **Not that the agent door is multi-currency.** It is one currency *per agent*:
  `Policy` holds a single `dailyCap`, a single `perTxCap` and a single
  `spentToday`, all in one token's units, so a wallet spending both would count
  €1 as $1 — about 13% adrift at these rates, and silent. The rule is enforced
  off-chain at the PBM door (`agent_currency_mismatch`), which means it is a
  door check and **not a contract guarantee**.
- **Not that euros cost more.** The 197,356 on the human row is the first euro
  payment ever made here and is cold storage; repeated warm it is 183,692, within
  21 gas of the dollar equivalent. See `docs/measurements.md`.
- **Not that INR works.** It is visibly locked in the payer's picker because no
  INR stablecoin exists on Base Sepolia. Shown rather than hidden, so the set
  does not read as closed.

---

## What a refusal costs

Rival work in this space measures a control's false-positive rate, because a
statistical control has one. Ours does not, and the honest answer is a different
shape rather than a smaller number.

**The category check has no error rate of its own.** It is
`bitmap & (1 << categoryId)` — no model, no threshold, no score. Given correct
inputs it refuses exactly the set it is defined to refuse, and §3's arithmetic
is the whole of it. So the question "how often does the policy refuse something
it shouldn't?" reduces exactly to "how often is `merchant.categoryId` wrong?"

That relocates the risk instead of removing it, and the place it lands is
already on our honest-gaps list: **`registerMerchant` takes the category from
the caller, and nothing reviews it.** A hawker who registers as `retail` is
refused by a food-only agent, correctly per the bitmap and wrongly per reality.
**The policy is exact; the registry is the soft part.** That is a sharper claim
than a percentage, and it is falsifiable.

Three costs that are real and worth stating:

- **The cap refuses a legitimate payment eventually, by design.** `dailyCap` is
  37.255049 USDC ≈ S$50.00, so the S$4.50 basket goes through 11 times and the
  12th is refused. That is not an error, but it is a cost, and unlike a risk
  score it is exactly computable in advance — which is the argument for a
  deterministic control rather than against it.
- **Category granularity is a real limit.** The bitmap is 256 wide; the clients
  know four. An owner can set a bit this build has no label for, which is why
  the payer app renders unrecognised *allowed* categories rather than dropping
  them, and captions the *denied* list as covering only the four it knows.
- **The policy binds amount, time, token and category — never the payee.**
  `SpendAuthorization` has three fields and none names a merchant. The only
  payee-adjacent input is `categoryId`, read from the core's own registry, and
  that registry is self-attested. So this constrains an honest miscategorisation,
  not a hostile merchant. Say **"how much, when, and what kind of shop — not
  which shop."**

A refusal costs 35,241 gas and no movement of funds. There is no partial state
to unwind, because the settlement was never broadcast.

---

## Checking any of this yourself

```bash
RPC=https://sepolia.base.org
CORE=0xE6289ceA9232af61d7e4F30A67a848c0C322cc93
WALLET=0xd99C11b07854704225e7F0135635c0A48A429cBd

# any receipt above
cast receipt <txHash> --rpc-url $RPC

# derive the merchant id from the handle yourself — merchantIdOf is `pure`,
# so this is keccak256(handle) and needs no trust in our numbers
cast call $CORE 'merchantIdOf(string)(bytes32)' "gadgethub-sg" --rpc-url $RPC
# -> 0x2486c28d8b9619433508558a3150fb83c2f06a66cc146b770a0a5a0ab719256e

# the two reads that make §3's refusal checkable against public state
cast call $CORE 'merchants(bytes32)(address,uint16,string,string,string,string)' \
  0x2486c28d8b9619433508558a3150fb83c2f06a66cc146b770a0a5a0ab719256e --rpc-url $RPC
# -> payout, categoryId 2, "gadgethub-sg", "GadgetHub SG", …

cast call $WALLET 'policy()(uint128,uint128,uint40,uint256)' --rpc-url $RPC
# -> dailyCap, perTxCap, expiry, categoryBitmap   (bitmap 2 → food_beverage only)

cast call $WALLET 'spentToday()(uint256)' --rpc-url $RPC
```

Note the merchant's `payout` in that second read is the deployer address — the
artifact described at the top of this file, visible rather than hidden.

Or through the deployed read surface:

```bash
curl https://gantry-backend.onrender.com/api/settlements?handle=ah-hock-chicken-rice
curl 'https://gantry-backend.onrender.com/api/denials?wallet=0xd99C11b07854704225e7F0135635c0A48A429cBd'
curl https://gantry-backend.onrender.com/api/agents/0xd99C11b07854704225e7F0135635c0A48A429cBd
```

**`/api/denials` requires the `wallet` parameter** and answers `400
MissingWallet` without it — the endpoint declines to build the aggregate of
every refusal the permissionless factory ever produced.

Two surfaces you can check without any key at all, and they are the shortest
proof of the thesis in this file:

```bash
# ONE URL. A machine is quoted; a browser is redirected into the payer app.
curl -i 'https://gantry-backend.onrender.com/pay/ah-hock-chicken-rice?sgd=4.50'
# -> 402 Payment Required + a PAYMENT-REQUIRED header
curl -i -H 'Accept: text/html' \
  'https://gantry-backend.onrender.com/pay/ah-hock-chicken-rice?sgd=4.50'
# -> 302 to https://gantry-innovatex.vercel.app/pay/ah-hock-chicken-rice?sgd=4.50

# the rail, enumerable by a machine that knows no handle
curl https://gantry-backend.onrender.com/discovery/resources
```

Decode that 402 and you get four ways to pay the same order —
`exact/USDC`, `exact/EURC`, `gantry-pbm/USDC`, `gantry-pbm/EURC` — priced by one
function against one merchant. `exact/USDC` is first because an unmodified client
takes the first entry without choosing.

Two shapes of the wire data worth knowing before you go looking: a denial row
carries `at` but **no block number**, and the `IntentSettled` figures are gross —
the merchant receives `xsgdOut − feeXsgd`.

`https://sepolia.base.org` **403s a default `urllib` user-agent**; use `curl` or
send a browser UA. It also returns `no backend is currently healthy` under load,
which is worth knowing because that node — not the paid provider — is the one
serving every `eth_getLogs` sweep chunk the indexer makes.
