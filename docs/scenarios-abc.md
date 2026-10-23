# Scenarios A / B / C on a shared booking

Status: **verified against Stripe Sandbox on 2026-10-23** (`npx vitest run tests/integration/abc.sandbox.test.ts`, 4/4),
through the real route handlers. Evidence: `test-results/sandbox/abc.json` (git-ignored).

Decisions: currency **PLN** (100 zł / 90 zł / 10 zł instead of the €100 / €90 / €10 in the study plan); scenario B is a
Destination Charge with manual capture, so the seller is paid only at capture; the booking is **kept only in Stripe
metadata** (no database).

## Booking model

A booking (`bk_` + 12 hex characters, item, customer, start and end date, amount, commission %) is created in the
dashboard's **Rezerwacja** tab. Each scenario run creates its own PaymentIntent carrying the booking as metadata
(`booking_id`, `booking_scenario`, `booking_item`, `booking_customer`, `booking_start`, `booking_end`); transfers carry
`booking_id` too. `GET /api/lab/bookings` rebuilds the booking list from lab PaymentIntents via the **Stripe Search
API**. Stripe documents that search results can lag behind writes; in the verified run all three PaymentIntents were
found after **5.6 s**. The dashboard keeps the current booking in memory, so the lag only affects the list of past bookings.

## Verified results (booking `bk_8416520aea5c`, 100.00 zł, commission 10%)

| | A — immediate deposit | B — authorization, capture later | C — delayed transfer |
| --- | --- | --- | --- |
| Stripe mechanism | Destination Charge, `capture_method: automatic` | Destination Charge, `capture_method: manual` | Separate Charges and Transfers |
| PaymentIntent | `pi_3UTkO1KKgVb6y81Y0gsAC7gu` | `pi_3UTkOBKKgVb6y81Y06z9IHJi` | `pi_3UTkOLKKgVb6y81Y0k62eVGC` |
| Transfer | `tr_3UTkO1KKgVb6y81Y0AMsQIk0` 100.00 (Stripe, automatic) | `tr_3UTkOBKKgVb6y81Y0gTnutkP` 100.00 (Stripe, at capture) | `tr_3UTkOLKKgVb6y81Y0LpVhDEN` 90.00 (platform's own call) |
| Before the decisive step | — | `requires_capture`: captured 0, no transfer, **no balance transactions on either side** ✓ | paid: seller 0.00, platform holds 95.75 (100 − 4.25 fee) ✓ |
| Seller allocation | **90.00** ✓ | **90.00** ✓ | **90.00** ✓ |
| Platform fee / kept | 10.00 (Application Fee) ✓ | 10.00 (Application Fee) ✓ | 10.00 (not transferred) ✓ |
| Stripe fee (platform) | 4.25 | 4.25 | 4.25 |
| Platform net | 5.75 | 5.75 | 5.75 |
| Who decides when the seller is paid | Stripe, at payment | Stripe, at capture | the platform |

All balance transactions are `pending` (7 days); nothing has settled. The Stripe fee of 4.25 zł on 100 zł matches the
3.25% + 1.00 zł measured earlier with `pm_card_visa`, a US-issued test card.

## Dashboard

Tabs: **Rezerwacja · A — Kaucja pobrana od razu · B — Autoryzacja, pobranie później · C — Opóźniony przelew ·
Porównanie A / B / C · Zwrot pieniędzy · Wygaśnięcie blokady · Konta sprzedawców.** Each scenario tab shows its own
payment for the current booking, the guided steps, and an "Oczekiwany wynik / Rzeczywisty wynik" table checked against
real Stripe data (✓, ✗, or "—" while the step hasn't been reached yet). The comparison tab loads all three payments side by side.
Refunds and the expiry simulation work on the A/B/C payments of the current booking.

The UI renders on `next dev` and builds. It was **not** clicked through by browser automation; the API calls it makes are
the ones verified above.
