# Phase 3 — Demonstration dashboard

Status: **implemented; all server flows verified against Stripe Sandbox on 2026-10-23** through the real route
handlers (`tests/integration/phase3.sandbox.test.ts`, 6/6). Each flow ended by inspecting the actual Stripe objects
and the balance transactions on both sides. The full suite passed 33/33: 16 unit tests + Phase 1 (4), Phase 2 (7)
and Phase 3 (6) against Stripe Sandbox.

**The dashboard UI itself was not clicked through in a browser by an automated test** (Playwright was skipped on purpose).
It type-checks, lints and builds, `next dev` serves it (HTTP 200, Polish title, `lang="pl"`), and the same API calls the
UI makes (same-origin JSON with an `Origin` header) were checked against `next dev`. A manual click-through is still recommended.

Evidence: `test-results/sandbox/phase3-*.json` (git-ignored). Run: `npx vitest run tests/integration/phase3.sandbox.test.ts`, UI: `npm run dev`.

## What the dashboard shows (UI in Polish; Stripe names, IDs and raw statuses unchanged)

| Tab | Content |
| --- | --- |
| 1. Autoryzacja i przechwycenie | Platform-only payment: authorize (manual), full/partial capture, cancel, refund |
| 2. Destination Charge | `transfer_data.destination` + `application_fee_amount`; partial capture re-sets a proportional fee; refund with `reverse_transfer` / `refund_application_fee`; Application Fee refund; manual transfer reversal |
| 3. Separate Charges and Transfers | Platform charge with `transfer_group`, explicit transfers (`source_transaction`), refunds and transfer reversals as separate operations |
| 4. Wygaśnięcie autoryzacji | Real `capture_before` from Stripe next to a browser-only simulation labeled **„SYMULACJA — bez operacji Stripe”** |
| Konta połączone | All 3 connected accounts, read-only, with capabilities; Accounts v2 readiness and seller/platform balance for the lab account only |
| Jak to działa | Charge-model comparison, liability, observed economics, limitations, production requirements; every statement labeled "verified in Sandbox" or "per Stripe docs" |

Always shown: PaymentIntent lookup by ID (lab-owned only), transaction details (PaymentIntent, Charge, Transfer(s) and
reversals, Refund(s), Application Fee and its refunds; actual Stripe fee, platform fee, transferred and seller amounts, each
split into pending/available), both ledgers, a timeline, the operation history with raw Stripe responses, and contextual
controls. Every disabled control shows its reason ("Niedostępne: …").

## Server-side safety rules (verified)

Every mutation re-reads Stripe state and refuses **before calling Stripe** (`LabRuleError`, kind `rule`):

| Rule | Verified refusal (HTTP) |
| --- | --- |
| Money moves only to the tagged lab account (create, confirm, capture, transfer: lab + ready via Accounts v2; reversal, fee refund, `reverse_transfer`: lab) | create destination to `acct_1UTeTNKKgVaFe2oa` → 403 |
| Details and every operation only for PaymentIntents with `metadata.lab` | details / capture / cancel / refund on untagged `pi_3UTjLsKKgVb6y81Y1VeN2zsw` → 403 |
| Transfers and fees are owned through their source charge's lab PaymentIntent | used for the Destination Charge transfer reversal and fee refund (200) |
| Capture ≤ `amount_capturable`, only in `requires_capture`, fee < captured amount | 6000 of 5000 → 422; second capture → 409 |
| Cancel only before capture | cancel after capture → 409 |
| Refund only after capture, ≤ captured − refunded; `reverse_transfer`/`refund_application_fee` only for Destination Charge | refund before capture → 409; 3001 of 3000 → 422; `reverse_transfer` on separate → 422 |
| Transfer only for Separate Charges, ≤ captured − refunded − already transferred | 1000 when 500 left → 422; transfer on destination → 422 |
| Reversal ≤ not-yet-reversed amount | reverse a fully reversed transfer → 409 |
| Application fee refund ≤ unrefunded fee | 1000 of 200 → 422 |

Unchanged from Phase 1: localhost-only (404 outside `development`/`test`, 403 for non-loopback Host or a cross-origin
`Origin`, 415 for non-JSON mutations), strict Zod bodies (now with Polish messages), PLN only, test-mode keys only.

## Verified Sandbox flows

All amounts are PLN grosze. Every balance transaction was `pending` (`available_on` 7 days later): **nothing has settled**.

### Destination Charge — authorize 50.00, partial capture 30.00, partial refund with reversal, fee refund, manual reversal

PI `pi_3UTjLuKKgVb6y81Y0JinMfjh`, charge `ch_3UTjLuKKgVb6y81Y04kG6SjB`, transfer `tr_3UTjLuKKgVb6y81Y0w2ibQTL` → `py_1UTjLyKKgVS24coWs3WEuObw`,
application fee `fee_1UTjLzKKgVS24coWGPhZGFus`.

| Step | Request | Result |
| --- | --- | --- |
| create (fee 500, manual) / confirm | req_MEf95rGMR7IIWA / req_whXslTVoyw63fa | `requires_capture` |
| capture 3000 with fee 300 | req_eFzGFhuafrrP4D | `succeeded`, transfer 3000, fee 300 |
| refund 1000, `reverse_transfer` + `refund_application_fee` | req_pELcbhbaeCpkgH | `re_3UTjLuKKgVb6y81Y03ErdOCe` with reversal `trr_1UTjM1KKgVb6y81YJMFU4nSe` 1000 and fee refund `fr_1UTjM1KKgVS24coWw3P2vr5i` **100** (proportional: 300 × 1000/3000) |
| application fee refund 100 | req_pZ7fNlq7Fa17HB | `fr_1UTjM8KKgVS24coW07ZnxTlN` |
| manual reversal 500 | req_U1Xf66PBl6Ebmd | `trr_1UTjM9KKgVb6y81YAwVGfMf3` |

Platform: charge 3000/198/2802, transfer −3000, application_fee +300, application_fee_refund −100 ×2, refund −1000,
transfer_refund +1000 and +500 → **net 402**. Seller: payment 3000/300/2700, adjustment +100 ×2, payment_refund −1000 and −500 →
**net 1400**. Stripe fee 198 · application fee net 100 · transferred net 1500 · no conversion ·
**402 + 1400 + 198 = 2000 = captured 3000 − refunded 1000** ✓. Timeline: 16 events, 13 with a request ID.

### Separate Charges and Transfers — charge 50.00, transfer 45.00, reversals, refund

PI `pi_3UTjMDKKgVb6y81Y1K8ApiTL`, charge `ch_3UTjMDKKgVb6y81Y1CoEm4q8`, transfer `tr_3UTjMDKKgVb6y81Y1TWv3Vv6` 4500 (req_W9aSR4NVBi4Wyy)
→ `py_1UTjMIKKgVS24coWCsgh5JCw`; reversal 1500 `trr_1UTjMLKKgVb6y81Y3C4oMAw0` (req_VlVlK1UzPFt3Cj); full refund `re_3UTjMDKKgVb6y81Y1Wzy9o27`
(req_RerHT4OiUJ4Yc2, `transfer_reversal: null`); remaining reversal 3000 `trr_1UTjMOKKgVb6y81YaUNWqfyC` (req_zHj2Tw9r4LzFEZ).

Platform: 4737 − 4500 + 1500 − 5000 + 3000 = **−263**. Seller: 4500 − 1500 − 3000 = **0**. Between the refund and the last reversal,
the seller still held 30.00 PLN of a fully refunded payment. Conservation ✓ (−263 + 0 + 263 = 0).

### Platform-only authorization, then cancel

PI `pi_3UTjMSKKgVb6y81Y1E9JUcwm`: confirm req_OxFOqRWI5El4J0 → cancel req_zvaOtiKthK2oag → `canceled`. **Zero balance transactions on the
platform**, so cancelling a hold costs nothing. This verifies the Phase 2 row that was marked "not measured". A refund before capture was refused (409).
Timeline: 4 events (`payment_intent.created`, `amount_capturable_updated`, `charge.succeeded`, `payment_intent.canceled`), all with request IDs.

## Authorization expiry: investigation and simulation

Investigated Stripe's docs (place-a-hold, testing, extended-authorization pages): **no documented Sandbox mechanism to force
card-authorization expiry** (no test card, test clock or helper for it). The only expiry patterns in the testing docs are for
voucher methods (Multibanco, Boleto, OXXO, Konbini). Documented outcome: *"If the authorization expires before you capture the funds,
the funds are released and the payment status changes to `canceled`."* The docs name no cancellation reason or capture error code,
so the simulation shows none. The dashboard keeps the **verified** side (`status` and `capture_before` from Stripe, a real-time countdown)
separate from the **simulated** side (browser clock moved past `capture_before`, the documented outcome), which never calls Stripe.

## Charge models — differences observed across Phases 2–3

| | Platform-only | Destination Charge | Separate Charges and Transfers |
| --- | --- | --- | --- |
| Seller paid | never | automatically at capture, full amount; the application fee is taken back from the seller | only by explicit transfers (any time, any amount up to the charge) |
| Platform commission | whole amount | `application_fee_amount` (a separate Application Fee object; re-set at partial capture) | whatever is not transferred (no fee object) |
| Stripe fee | platform | platform | platform |
| Refund | from platform | from platform; `reverse_transfer` recovers from the seller in the same call; `refund_application_fee` returns the fee proportionally | from platform; the seller keeps the transfer until a separate reversal |
| Transfer reversal | — | possible manually as well (verified) | required to recover funds |
| Timing | — | transfer and fee created asynchronously (~3–4 s after `succeeded`, no request ID) | transfer created synchronously by the platform's own call |

## New limitations found in Phase 3

1. **The balance transaction `source` filter is incomplete.** `transfer_refund` entries report `source = tr_…`, but
   `?source=tr_…` does not return them; they are found only by the reversal ID (`trr_…`). Seller-side `adjustment` entries for
   application fee refunds report `source = py_…`, but no source filter returns them (`py_`, `fr_`, `fee_` tried). The seller ledger is
   therefore listed by time since the PaymentIntent and matched on the reported `source`.
2. **`application_fee.charge` is the seller-side payment** (`py_…` on the connected account) for Destination Charges. The platform charge
   is `application_fee.originating_transaction`. The first ownership check used `charge` and failed with 404; fixed.
3. **Stripe Events lag and are not complete for automatic changes.** Events caused by Stripe itself (e.g. `application_fee.created`)
   have `request: null`. Events are kept for 30 days, so older lab payments show an incomplete timeline. No event is reconstructed.
4. **Prerendering of lab GET routes.** `next build` prerendered GET routes whose guard returned 404 without reading the request. The guard
   now reads the `Host` header first, which makes every lab route request-time. (`connection()` was tried, but it throws when route
   handlers are called directly in tests.)
5. As before: nothing settled, no payouts or disputes tested, Stripe fee measured only for the US test card, history only in the browser tab.

## API added in Phase 3

| Route | Purpose |
| --- | --- |
| `POST /api/lab/payment-intents` | now also `chargeModel` (`platform`/`destination`/`separate`), `captureMethod`, `accountId`, `applicationFeeAmount` |
| `POST /api/lab/payment-intents/[id]/capture` | now also `applicationFeeAmount` (Destination Charge) |
| `POST /api/lab/payment-intents/[id]/refund` | refund with optional `amount`, `reverseTransfer`, `refundApplicationFee` |
| `GET /api/lab/payment-intents/[id]/details` | objects, ledgers, funds, Events timeline, `capture_before` deadline (lab PIs only) |
| `POST /api/lab/transfers` | Separate Charges transfer from a lab PaymentIntent to its lab seller |
| `POST /api/lab/transfers/[id]/reversals` | transfer reversal |
| `POST /api/lab/application-fees/[id]/refunds` | application fee refund |
| `GET /api/lab/connect/accounts` | now **all** connected accounts (read-only), readiness for lab accounts |
| `GET /api/lab/connect/accounts/[id]/balance` | seller and platform balance (lab account only) |

Removed: `POST /api/lab/connect/accounts` (account creation from the dashboard is out of scope; the existing lab account is reused).

---

## Update: guided scenarios for non-technical users (2026-10-23)

### Root cause of `Utwórz PaymentIntent: Nie znaleziono [HTTP 404, forbidden]`

The error came from the lab's own guard (`src/lib/lab/guard.ts`), not from Stripe or routing. The dashboard was used
on the Vercel production deployment of this repository (project `next-stripe-test`, deployed from `main`), where
`NODE_ENV=production`, and the guard deliberately refuses every lab API call outside `development`/`test` (and
non-localhost hosts). Locally (`npm run dev`, `http://localhost:3000`) all flows work. The dashboard now explains
this in Polish instead of showing the raw error.

### Public test mode on Vercel (approved by the owner for the temporary Sandbox)

On a Vercel deployment (`VERCEL=1`) the lab API is now open to testers **without login**. Set `LAB_PUBLIC_ACCESS=0` in
the Vercel environment variables (and redeploy) to lock it again; without `VERCEL`, production stays locked (404) as before.
Still enforced in public mode: Sandbox (test-mode) keys only, money only to the tagged lab seller account, same-origin JSON
for every mutation, and at most **500 zł per payment** (`PUBLIC_MAX_AMOUNT`, checked before Stripe is called). Accepted
risk: anyone with the URL (or a script) can create Sandbox payments and transfers; no real money is involved.

Verified on a local production build (`next build` + `next start` with `VERCEL=1`): config reports `publicMode=true`,
`maxAmount=50000`; 600 zł refused (422); 50 zł hold created and confirmed (`pi_3UTjwxKKgVb6y81Y1iNlYj0N`, req_gOxwwk037l69q7)
and released (req_AP1JWVT6K3G7nO); cross-origin cancel refused (403); payment to a non-lab seller refused (403). The
`LAB_PUBLIC_ACCESS=0` lock is covered by unit tests only (a running-server check was not completed).

### New interface (Polish)

Tabs: **1. Blokada kaucji · 2. Pobranie kaucji · 3. Podział płatności · 4. Przekazanie pieniędzy · 5. Zwrot pieniędzy ·
6. Wygaśnięcie blokady · 7. Konta sprzedawców.** Each scenario shows what the user is about to do and what happens to
the customer's, seller's and platform's money; a guided step list whose completion is derived from the real Stripe
state; amounts in złoty (converted to integer grosze); sensible defaults (50 zł, 10% commission, 45 zł transfer).

After every operation a result card shows success/failure and what Stripe executed, a plain-language account of the
money built from real balance transactions, the status, a money-flow diagram (Klient → Platforma → Stripe →
Sprzedawca; a hold is a lock on the card, never an arrow), next actions, and a timeline from Stripe Events. Stripe
terminology, IDs, ledgers, raw responses, the test-card choice, PaymentIntent lookup and all technical controls are in
expandable "szczegóły techniczne" / "Tryb zaawansowany" sections. The expiry tab keeps the labeled simulation.

Verification: type check, lint, production build; unit tests 22/22 (including złoty parsing and the money reading checked
against the real Phase 3 Sandbox payments); the page renders on `next dev`. The guided UI was **not** clicked through by
browser automation; all API calls it makes are the ones verified by the Phase 3 Sandbox tests. Server code is unchanged.
