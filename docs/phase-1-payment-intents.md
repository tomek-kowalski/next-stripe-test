# Phase 1 — PaymentIntents and manual capture

Status: **all 4 scenarios executed and passed against Stripe Sandbox in PLN on 2026-10-23** (`npm run test:sandbox`,
4/4). The API routes were also run over HTTP via `next dev`. Raw evidence for the latest run is written to
`test-results/sandbox/<scenario>.json` (git-ignored). The dashboard UI has not been checked by a browser test yet
(Playwright is Phase 5).

Environment: stripe-node 23.0.1, pinned API version `2026-09-30.endive`, Next.js 16.4.2.
Sandbox account `acct_1UQsS6KKgVb6y81Y` ("Next.js Connect Lab"), country **PL**, default currency **pln**.
**Currency: PLN only.** The API rejects any other currency (`"Only PLN is supported."`); amounts are grosze.
Test amount 5000 (50.00 PLN), partial capture 2000 (20.00 PLN), card `pm_card_visa`.

## Key findings

1. **The authorization window is 7 days.** `capture_before` was exactly 168 h after confirmation in every run
   (e.g. confirmed 2026-10-23T12:42Z → `capture_before` 2026-10-30T12:42Z).
2. **Extended authorization is not active by default.** `extended_authorization.status = "disabled"`.
   `multicapture`, `overcapture` and `incremental_authorization` are all `"unavailable"` for this account and card.
3. **Partial capture releases the remainder without a refund.** This contradicted the original expectation:
   `amount_refunded` stays `0`, `refunded = false`, and no Refund object is created. The released amount is only
   visible as `charge.amount − charge.amount_captured` (5000 − 2000 = 3000) with `amount_capturable = 0`.
   This was first seen in an early EUR run (`pi_3UThn3KKgVb6y81Y0s5EKoBr`), the check was corrected, and the PLN runs confirm it.
4. **Only one capture.** A second capture after a partial capture fails with `payment_intent_unexpected_state`:
   "the remainder of the authorized amount has been released".
5. **A captured PaymentIntent can't be canceled.** It fails with `payment_intent_unexpected_state`. The error lists
   the statuses that can be canceled, including `requires_reauthorization` and `expired` (relevant to Phase 3).
6. **PLN avoids currency conversion.** The account settles in PLN. A 50.00 PLN capture settled 1:1
   (balance transaction 5000 PLN, `exchange_rate: null`, Stripe fee 263, net 4737). An early EUR test (20.00 EUR → 8786 PLN,
   fee 562) showed the currency conversion that a non-PLN deposit would incur. This is why the lab is PLN-only.

## Common setup for every scenario

- Each scenario creates its **own** PaymentIntent (`metadata.scenario` = scenario ID), so runs are independent.
- `capture_method: "manual"`, `allowed_payment_method_types: ["card"]`, `currency: "pln"`, amounts in integer grosze.
- API compatibility: on `2026-09-30.endive` the create parameter `payment_method_types` **no longer exists**.
  `allowed_payment_method_types` replaces it (the response still contains `payment_method_types`).
- Every mutation sends an idempotency key (a UUID per dashboard click or test step). SDK auto-retries are
  disabled (`maxNetworkRetries: 0`) so the lab shows the real result of each request.
- Every response expands `latest_charge`, because authorization details (`amount_authorized`, `capture_before`,
  `extended_authorization`) are on `charge.payment_method_details.card`, not on the PaymentIntent.

Checks marked **assert** are expectations; checks marked **info** only record the value Stripe returns.

---

## 1. `authorize-inspect` — authorize and inspect expiration

1. **Business purpose.** Place a security-deposit hold on the renter's card without moving money, and find out
   how long the hold stays valid.
2. **Stripe API calls.** `POST /v1/payment_intents` (amount, currency, capture_method=manual) →
   `POST /v1/payment_intents/:id/confirm` (payment_method=pm_card_visa) → `GET /v1/payment_intents/:id?expand[]=latest_charge`.
3. **Expected state transitions.** `requires_payment_method` → `requires_capture`; `amount_capturable = amount`,
   `amount_received = 0`, `charge.captured = false`, `card.amount_authorized = amount`. `capture_before` recorded as info.
4. **Actual Sandbox results.** **Passed (PLN).** `pi_3UThsAKKgVb6y81Y0IYC7oz9`: create → `requires_payment_method`, `currency = pln`
   (req_gy8ADEZWroesIi); confirm → `requires_capture`, `amount_capturable = 5000`, `amount_authorized = 5000`,
   `captured = false` (req_QSAxPO6j7l1P6a); retrieve unchanged (req_MImRWNHt6LNpYV).
   `capture_before` = 2026-10-30T12:47:02Z (168 h), `extended_authorization.status = "disabled"`.
5. **Limitations.** Sandbox does not let you wait for a real expiry; `capture_before` is the value Stripe reports,
   not an observed release. Expiry behaviour is covered in Phase 3.
6. **C2C implications.** The platform must store `capture_before` per deposit and capture, cancel or switch strategy
   before it passes. In this account that is 7 days, so a card hold cannot cover a rental longer than about a week.

## 2. `capture-full` — authorize, then capture the full amount

1. **Business purpose.** Charge the whole deposit (e.g. a damage claim equal to or larger than the deposit).
2. **Stripe API calls.** create → confirm → `POST /v1/payment_intents/:id/capture` (no `amount_to_capture`) → retrieve.
3. **Expected state transitions.** `requires_capture` → `succeeded`; `amount_received = amount`, `amount_capturable = 0`,
   `charge.captured = true`, `charge.amount_captured = amount`, `charge.amount_refunded = 0`.
4. **Actual Sandbox results.** **Passed (PLN).** `pi_3UThsBKKgVb6y81Y1ptUJEKk`: confirm → `requires_capture` (req_efpNjVtes8aeNn);
   capture → `succeeded`, `amount_received = 5000`, `amount_capturable = 0`, `amount_captured = 5000`, `amount_refunded = 0`
   (req_pXxacOK4Z8WKde); retrieve unchanged (req_R84ZckXEhf7V5w). Balance transaction: 5000 PLN, fee 263, net 4737, no conversion.
5. **Limitations.** No connected account yet; funds stay on the platform (Phase 2 adds destination charges and transfers).
6. **C2C implications.** Capture happens once (verified in scenario 3), so the decision to claim the deposit must be
   final at capture time. Stripe's fee is taken from the captured amount (2.63 PLN on 50.00 PLN in Sandbox).

## 3. `capture-partial` — authorize, then capture part of the amount

1. **Business purpose.** Claim part of the deposit (e.g. a cleaning fee) and release the rest of the hold to the renter.
2. **Stripe API calls.** create → confirm → `POST /v1/payment_intents/:id/capture` (`amount_to_capture` < amount) → retrieve.
3. **Expected state transitions.** `requires_capture` → `succeeded`; `amount_received = partialAmount`, `amount_capturable = 0`,
   `charge.amount_captured = partialAmount`. Originally the released remainder was expected to appear as
   `charge.amount_refunded = amount − partialAmount`. Sandbox showed otherwise, and the corrected assertion is
   `amount_refunded = 0` with `charge.amount − amount_captured = amount − partialAmount`.
4. **Actual Sandbox results.** **Passed (PLN).** `pi_3UThsDKKgVb6y81Y0LbB7WI1`: capture 2000 → `succeeded`,
   `amount_received = 2000`, `amount_capturable = 0`, `amount_captured = 2000`, `amount_refunded = 0`, released remainder 3000
   (req_aBOMkk9aMk5C7j); retrieve unchanged (req_jcKuoP3JLINTHL).
   History (EUR, before the PLN-only change): the first run `pi_3UThn3KKgVb6y81Y0s5EKoBr` failed only on the original
   `amount_refunded = 3000` expectation (Key finding 3). HTTP check `pi_3UThoFKKgVb6y81Y15sZAWds` (3000, partial 1200): a second capture returned 400
   `payment_intent_unexpected_state` (req_hrqBBP2UMQYZ1E).
5. **Limitations.** How fast the issuer releases the remainder to the cardholder cannot be observed in Sandbox.
6. **C2C implications.** One capture per authorization (verified). Claims for several deposit items must be summed
   before capture. Reconciliation must compute the released amount from `amount − amount_captured`, because it never
   appears as a refund.

## 4. `cancel-authorization` — authorize, then cancel

1. **Business purpose.** Return the whole deposit: the rental ended without damage.
2. **Stripe API calls.** create → confirm → `POST /v1/payment_intents/:id/cancel` (cancellation_reason=requested_by_customer) → retrieve.
3. **Expected state transitions.** `requires_capture` → `canceled`; `cancellation_reason = requested_by_customer`,
   `amount_received = 0`. `amount_capturable` and how the charge reports the release are recorded as info.
4. **Actual Sandbox results.** **Passed (PLN).** `pi_3UThsFKKgVb6y81Y0utYuqE2`: cancel → `canceled`,
   `cancellation_reason = requested_by_customer` (req_CSgQiq8jIogGFd); retrieve unchanged (req_eR4paPRD8X04jG).
   Observed: `amount_capturable = 0`, `charge.captured = false`, `amount_refunded = 0`, `refunded = false`, so this
   release is not reported as a refund either. In an earlier EUR HTTP check, canceling an already captured PaymentIntent returned 400
   `payment_intent_unexpected_state` (req_gYQKdrHvdrc56z).
5. **Limitations.** As with partial capture, release timing on the cardholder's statement cannot be observed.
6. **C2C implications.** Cancel is final, and a canceled PaymentIntent cannot be re-authorized, so a new deposit needs
   a new PaymentIntent. Cancel is only possible before capture.

---

## Security controls (verified by unit tests and HTTP smoke tests)

- The Stripe client refuses any key that is not `sk_test_…`/`rk_test_…`.
- `/api/lab/*` return 404 unless `NODE_ENV` is `development` or `test` (so `next start` and deployments are off),
  403 for non-loopback `Host` headers and cross-origin `Origin`, and 415 for non-JSON mutations (blocks CSRF via
  simple form posts).
- Currency is fixed to PLN in the schema; `eur`, `usd` and even `PLN` (upper case) return 400.
- Request bodies are strict Zod objects: unknown fields such as `capture_method` or `application_fee_amount` are
  rejected, so callers cannot inject Stripe parameters. PaymentIntent IDs must match `pi_[A-Za-z0-9]+`.
