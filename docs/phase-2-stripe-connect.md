# Phase 2 — Stripe Connect

Status: **all 6 scenarios (7 runs, scenario 6 in two variants) executed and passed against Stripe Sandbox on
2026-10-23** (`npx vitest run tests/integration/phase2.sandbox.test.ts`, 7/7). Full evidence per run (every
request ID, object, balance transaction and check) is in `test-results/sandbox/phase2-<scenario>.json`
(git-ignored). The IDs below are from the final run at 13:28–13:29 UTC.

**Nothing in this phase has settled.** Every balance transaction on both sides was still `pending`, with
`available_on` = 2026-10-30. "Net" below is the *recorded* allocation, not funds that are available or paid out.

Environment: stripe-node 23.0.1, API `2026-09-30.endive`, platform `acct_1UQsS6KKgVb6y81Y` (PL, PLN), all amounts PLN grosze.
Test card `pm_card_visa`.

## Key findings

1. **Accounts v1 creation is blocked.** `POST /v1/accounts` returned 400: "Stripe no longer recommends Accounts v1
   for new Connect integrations. Create connected accounts with POST /v2/core/accounts instead" (req_S28pC45hBl5kWA).
   The account was created with Accounts v2. Its `acct_` ID works unchanged with the v1 PaymentIntent, Charge,
   Transfer, Refund and Balance Transaction APIs.
2. **The platform keeps 5.00 PLN gross but only 2.37 PLN net per 50.00 PLN destination charge.** Stripe's
   processing fee (2.63 PLN) is charged to the platform, not to the connected account. The seller receives exactly
   45.00 PLN. The same split comes out of separate charges and transfers.
3. **Stripe fee observed:** 263 on 5000 and 198 on 3000, which fits **3.25% + 1.00 PLN**. `pm_card_visa` is a
   US-issued test card, so this is probably the international-card rate; the fee for Polish/EEA cards has not
   been measured. Express pricing for active accounts and payouts (`fees_collector: application_express`) is
   billed separately and does not appear in these balance transactions.
4. **Stripe does not return its processing fee on refunds.** Every fully refunded scenario leaves the platform at
   **−2.63 PLN**. For a deposit model, charge-and-refund costs the platform the full processing fee every time.
5. **Destination transfers are asynchronous after automatic capture.** The PaymentIntent reported `succeeded`
   ~3.5 s before `charge.transfer` and `charge.application_fee` existed (3546 ms in the final run). Code must not
   read them straight after confirmation. Use webhooks (Phase 5) or poll.
6. **No currency conversion** anywhere: every balance transaction on both sides is PLN, `exchange_rate: null`.
7. **A refunded charge cannot fund a later transfer.** After a full refund, a transfer with `source_transaction`
   was rejected: "Transfers using this transaction as a source must not exceed the source amount of 0.00 zł"
   (req_LwAENQwitFJpbw).
8. **Refunding a separate charge does not touch the transfer.** The refund debits the platform 50.00 PLN and the
   seller keeps 45.00 PLN until the platform explicitly reverses the transfer. With destination charges,
   `reverse_transfer` + `refund_application_fee` unwind everything in one refund call.

## Connected account

| Item | Value |
| --- | --- |
| Account | `acct_1UTi5VKKgVS24coW`, created by this lab via Accounts v2 (req_v2J4h6jTXsyyaU5oD), `metadata.lab = stripe-connect-lab` |
| Type | Express Dashboard (`dashboard: express`; v1 view `type: express`) |
| Responsibilities | `fees_collector: application_express`, `losses_collector: application`, `requirements_collector: stripe` |
| Country / currency | PL / `defaults.currency = pln`; payout bank account `ba_…2874` (PL, PLN, default for currency) |
| Capabilities (v2) | `card_payments` active, merchant `stripe_balance.payouts` active, recipient `stripe_balance.stripe_transfers` active, recipient `stripe_balance.payouts` active |
| v1 view | `charges_enabled: true`, `payouts_enabled: true`, `card_payments`/`transfers` active, no `currently_due`/`past_due`, `disabled_reason: null` |
| Payout schedule | daily, 7-day delay |
| Readiness | Rechecked via Accounts v2 before every scenario; all 7 runs: ready (e.g. req_v2c8shfLbky3fn45f) |

The 2 connected accounts that existed before this phase (`acct_1UTeTNKKgVSdYm18`, `acct_1UTeTNKKgVaFe2oa`)
were only listed (read-only). The lab refuses mutations and payments to any account without its tag.

### Onboarding observations

- Account Links (v2) expire after ~5 minutes. The first link expired unused, and onboarding had to be retried.
- Hosted onboarding collected the terms of service, nationality and the bank account. Name, address and
  phone were then still reported `past_due`. The identity entered in the hosted form replaced the prefilled
  Stripe test values and did not pass Sandbox verification. The platform could update name, address and phone
  via v2 (req_v2PUp2dxfpolmBleA). Writing date of birth was refused with **403**: "You do not have permission to
  write to identity.individual.date_of_birth … the Account was onboarded via an Account Link" (req_v2eEyqpDLjg2jrCVg).
- Verification is asynchronous. The requirements moved to `awaiting_action_from: stripe` and cleared about 40 s later.
  For a short time the v1 view already showed `active` capabilities while v2 still showed `pending`.
- Hosted onboarding also cleared `defaults.profile.product_description` that had been prefilled.

**Production implication:** the platform cannot finish or fix an Express seller's KYC itself. Sellers must go
through hosted onboarding (or a later `account_update` link), and readiness must be checked from Stripe's
state (webhooks), not assumed after the redirect back.

## Charge models and liability

| | Destination charge (tested) | Separate charges and transfers (tested) | Direct charge (documented only, not tested) |
| --- | --- | --- | --- |
| Charge lives on | Platform | Platform | Connected account (`Stripe-Account` header) |
| Merchant of record / statement | Platform (no `on_behalf_of` used) | Platform | Connected account |
| Stripe processing fee paid by | Platform (**observed**) | Platform (**observed**) | Connected account by default |
| Seller funds | Automatic transfer of the full amount; the application fee is then taken back from the seller (**observed**) | Platform creates transfers explicitly, any amount and timing (**observed**) | Settled directly on the seller; the platform takes an `application_fee_amount` |
| Refund debited from | Platform balance (**observed**); recover from the seller with `reverse_transfer` (**observed**) | Platform balance (**observed**); recover with a separate transfer reversal (**observed**) | Connected account balance |
| Disputes / chargebacks | Debited from the platform; the platform may reverse the transfer (Phase 4) | Debited from the platform; the platform may reverse the transfer (Phase 4) | Debited from the connected account |
| Negative balances | Platform | Platform | Platform, because this account has `losses_collector: application` |

"Documented only" rows come from Stripe's Connect documentation and this account's `responsibilities`, not from a
Sandbox run. Dispute behaviour is scheduled for Phase 4.

---

## Scenario results

Ledger columns: `amount / fee / net` in grosze, all `pending`, `available_on` 2026-10-30.

### 1. `destination-application-fee` — destination charge 50.00 PLN, 5.00 PLN application fee

1. **Business purpose.** The renter pays 50.00 PLN; the seller gets 45.00 PLN; the platform keeps a 10% commission.
2. **Stripe API calls.** `POST /v1/payment_intents` (amount 5000, pln, `confirm: true`, `payment_method: pm_card_visa`,
   `application_fee_amount: 500`, `transfer_data.destination: acct_1UTi5V…`) → `GET /v1/charges/:id` (expand transfer, application_fee).
3. **Expected transitions.** PI `succeeded`; one transfer of the full 5000 to the seller; application fee 500 back to the platform.
4. **Actual Sandbox results.** **Passed.** PI `pi_3UTiWbKKgVb6y81Y0O0x226Z` `succeeded` (req_Lbu2z4cmE8Vog6), charge
   `ch_3UTiWbKKgVb6y81Y0tSOXVPU` `succeeded`, transfer `tr_3UTiWbKKgVb6y81Y05Eu06uO` 5000 → destination payment
   `py_1UTiWfKKgVS24coWwlLabaFE`, application fee `fee_1UTiWfKKgVS24coWQ7y6VXMZ` 500. Transfer and fee appeared 3546 ms after `succeeded`.

   | Side | Balance transaction | Type | Source | amount / fee / net |
   | --- | --- | --- | --- | --- |
   | Platform | `txn_3UTiWbKKgVb6y81Y0ef1fXAC` | charge | ch_…VPU | 5000 / 263 / 4737 |
   | Platform | `txn_3UTiWbKKgVb6y81Y08K0uSe2` | transfer | tr_…6uO | −5000 / 0 / −5000 |
   | Platform | `txn_1UTiWgKKgVb6y81Yiac7SVrX` | application_fee | fee_…VMZ | 500 / 0 / 500 |
   | Connected | `txn_1UTiWfKKgVS24coWcqB7zdHH` | payment | py_…baFE | 5000 / 500 (application_fee) / 4500 |

   **Stripe fee 263 · platform net 237 (2.37 PLN) · seller net 4500 (45.00 PLN) · no conversion.**
5. **Limitations.** Not settled (pending until 2026-10-30). Express pricing is not visible here.
6. **C2C implications.** A 10% commission leaves 4.74% after this fee. Price the commission (or a buyer service fee) to cover
   Stripe's fee. The seller's ledger shows the application fee as a fee on their payment.

### 2. `destination-manual-full-capture` — manual authorization, full capture, destination charge

1. **Business purpose.** Hold the 50.00 PLN deposit and charge it in full for a claim.
2. **Stripe API calls.** create+confirm with `capture_method: manual` (+ fee 500, destination) → `GET /v1/charges/:id` → `POST /v1/payment_intents/:id/capture`.
3. **Expected transitions.** `requires_capture` with **no transfer**, then `succeeded` with a transfer of 5000 and a fee of 500.
4. **Actual Sandbox results.** **Passed.** PI `pi_3UTiWkKKgVb6y81Y1Q3830sH`: `requires_capture` (req_X2ejw4BjObBDUk), charge
   `ch_3UTiWkKKgVb6y81Y10Ww7hs5` `captured=false transfer=none` (req_MQX2rgRppqdsSU); capture → `succeeded` (req_1BSeiPWrgsBnsA);
   transfer `tr_3UTiWkKKgVb6y81Y193ejJiq` 5000 → `py_1UTiWmKKgVS24coWTEJzEfpQ`; fee `fee_1UTiWmKKgVS24coWf7mPXl7o` 500.

   | Side | Balance transaction | Type | amount / fee / net |
   | --- | --- | --- | --- |
   | Platform | `txn_3UTiWkKKgVb6y81Y1CTm41Nt` | charge | 5000 / 263 / 4737 |
   | Platform | `txn_3UTiWkKKgVb6y81Y1orrgfxN` | transfer | −5000 / 0 / −5000 |
   | Platform | `txn_1UTiWnKKgVb6y81YZvYl3VoK` | application_fee | 500 / 0 / 500 |
   | Connected | `txn_1UTiWmKKgVS24coW1KRBtQkV` | payment | 5000 / 500 / 4500 |

   **Stripe fee 263 · platform net 237 · seller net 4500 · no conversion.** No balance transactions existed before capture.
5. **Limitations.** The 7-day authorization window from Phase 1 applies. Not settled.
6. **C2C implications.** Authorization creates no money movement and no seller balance; everything happens at capture.

### 3. `destination-manual-partial-capture` — manual authorization, partial capture 30.00 PLN

1. **Business purpose.** Hold 50.00 PLN and claim 30.00 PLN; release the rest.
2. **Stripe API calls.** create+confirm (manual, fee 500, destination) → `capture` with `amount_to_capture: 3000`, `application_fee_amount: 300`.
3. **Expected transitions.** `succeeded`, `amount_received = 3000`; transfer 3000; fee re-set to 300 at capture.
4. **Actual Sandbox results.** **Passed.** PI `pi_3UTiWqKKgVb6y81Y1juSetSq` (req_sLZlgbJ2kVfwoU, capture req_3GjmqfkB8V9gO8),
   charge `ch_3UTiWqKKgVb6y81Y1U7wFROj` captured 3000, transfer `tr_3UTiWqKKgVb6y81Y168QPzzY` 3000 → `py_1UTiWsKKgVS24coWDGhWAiiP`,
   fee `fee_1UTiWsKKgVS24coWrL46QmYf` **300** (the fee passed at capture replaced the 500 set at creation).

   | Side | Balance transaction | Type | amount / fee / net |
   | --- | --- | --- | --- |
   | Platform | `txn_3UTiWqKKgVb6y81Y1AuSVcXp` | charge | 3000 / 198 / 2802 |
   | Platform | `txn_3UTiWqKKgVb6y81Y161wNcUe` | transfer | −3000 / 0 / −3000 |
   | Platform | `txn_1UTiWtKKgVb6y81Y8FeEhsJn` | application_fee | 300 / 0 / 300 |
   | Connected | `txn_1UTiWsKKgVS24coW1NkgmVFS` | payment | 3000 / 300 / 2700 |

   **Stripe fee 198 (charged on the captured amount only) · platform net 102 · seller net 2700 · no conversion.**
5. **Limitations.** What happens if no fee is passed at capture (is 500 kept on a 3000 capture?) was not tested.
6. **C2C implications.** Always set `application_fee_amount` again at partial capture. The fixed 1.00 PLN part of the
   fee hurts small claims: here the platform keeps 1.02 PLN of a 3.00 PLN commission.

### 4. `separate-charge-transfer` — 50.00 PLN platform charge, then 45.00 PLN transfer

1. **Business purpose.** Collect on the platform first and decide later how much the seller gets.
2. **Stripe API calls.** create+confirm with `transfer_group` → `POST /v1/transfers` (4500, pln, destination, `source_transaction: ch_…`, same `transfer_group`).
3. **Expected transitions.** PI `succeeded`; transfer 4500; no application fee object.
4. **Actual Sandbox results.** **Passed.** PI `pi_3UTiWxKKgVb6y81Y0jEHT4pv` (req_F2BGXCOVCxnWvj), charge `ch_3UTiWxKKgVb6y81Y0jOB20RH`,
   transfer `tr_3UTiWxKKgVb6y81Y0Y2mnQvp` 4500 (req_YJBxD2RweVxle0) → `py_1UTiWyKKgVS24coWrYdxlM53`.

   | Side | Balance transaction | Type | amount / fee / net |
   | --- | --- | --- | --- |
   | Platform | `txn_3UTiWxKKgVb6y81Y0nw5KMrE` | charge | 5000 / 263 / 4737 |
   | Platform | `txn_3UTiWxKKgVb6y81Y04JJzpmN` | transfer | −4500 / 0 / −4500 |
   | Connected | `txn_1UTiWyKKgVS24coWiywaO3U4` | payment | 4500 / 0 / 4500 |

   **Stripe fee 263 · platform net 237 · seller net 4500 · no conversion.** No application fee object exists; the
   commission is simply the part not transferred.
5. **Limitations.** `source_transaction` was required in practice: the platform's *available* balance was 1.75 PLN.
   A transfer drawn from available balance was not tested. The transfer is recorded while the charge is still pending.
6. **C2C implications.** This model allows "hold now, pay the seller after the rental". The platform must track
   charge-to-transfer links (`transfer_group`) itself, which is hard without a database (see README constraints).

### 5. `refund-before-transfer` — separate charge refunded before any transfer

1. **Business purpose.** The booking is cancelled before the seller is paid.
2. **Stripe API calls.** create+confirm (`transfer_group`) → `POST /v1/refunds` (full) → probe: `POST /v1/transfers` with `source_transaction`.
3. **Expected transitions.** Refund `succeeded`; the seller gets nothing.
4. **Actual Sandbox results.** **Passed.** PI `pi_3UTiX2KKgVb6y81Y1bXvSpbF` (req_px4SGuAWfMutfV), charge `ch_3UTiX2KKgVb6y81Y1lZG1hiv`
   refunded 5000, refund `re_3UTiX2KKgVb6y81Y1LXALwtF` `succeeded` (req_Sd4WZ1tmHEhjdE). Probe transfer **rejected** (req_LwAENQwitFJpbw):
   "must not exceed the source amount of 0.00 zł".

   | Side | Balance transaction | Type | amount / fee / net |
   | --- | --- | --- | --- |
   | Platform | `txn_3UTiX2KKgVb6y81Y1PCJkt4G` | charge | 5000 / 263 / 4737 |
   | Platform | `txn_3UTiX2KKgVb6y81Y1vWSJVZq` | refund | −5000 / 0 / −5000 |
   | Connected | — | — | none |

   **Stripe fee 263, not returned · platform net −263 · seller net 0 · no conversion.**
5. **Limitations.** Refund `succeeded` in Sandbox at once; real refunds take days to reach the cardholder.
6. **C2C implications.** Cancelling after capture costs the platform 2.63 PLN per 50.00 PLN. For deposits, cancelling
   an authorization (Phase 1, free) is much better than charge-and-refund.

### 6a. `refund-after-transfer-separate` — separate charge + transfer, then refund and transfer reversal

1. **Business purpose.** The seller was paid, then the renter gets a full refund; recover the money from the seller.
2. **Stripe API calls.** create+confirm → transfer 4500 → `POST /v1/refunds` (full) → `POST /v1/transfers/:id/reversals` (full).
3. **Expected transitions.** The refund comes from the platform; the reversal brings 4500 back; both sides net to zero except Stripe's fee.
4. **Actual Sandbox results.** **Passed.** PI `pi_3UTiX9KKgVb6y81Y1g7XohOB`, charge `ch_3UTiX9KKgVb6y81Y1NeKxabk`, transfer
   `tr_3UTiX9KKgVb6y81Y1TZzvtfr` 4500 (req_HpdSKVwcgNU7mS), refund `re_3UTiX9KKgVb6y81Y1f0weXlQ` `succeeded` with
   `transfer_reversal: null` (req_5xTRH6c4gipcCz), reversal `trr_1UTiXCKKgVb6y81YUnteKLow` 4500 (req_AABJhnhgMTuei6).

   | Side | Balance transaction | Type | amount / fee / net |
   | --- | --- | --- | --- |
   | Platform | `txn_3UTiX9KKgVb6y81Y1QhIrKx8` | charge | 5000 / 263 / 4737 |
   | Platform | `txn_3UTiX9KKgVb6y81Y1kUptVim` | transfer | −4500 / 0 / −4500 |
   | Platform | `txn_3UTiX9KKgVb6y81Y10yIji1j` | refund | −5000 / 0 / −5000 |
   | Platform | `txn_1UTiXCKKgVb6y81YezIF7yS5` | transfer_refund | 4500 / 0 / 4500 |
   | Connected | `txn_1UTiXAKKgVS24coWFsGxWIYL` | payment | 4500 / 0 / 4500 |
   | Connected | `txn_1UTiXCKKgVS24coWiRRcejD6` | payment_refund (`pyr_1UTiXBKKgVS24coWe573PlIc`) | −4500 / 0 / −4500 |

   **Stripe fee 263, not returned · platform net −263 · seller net 0 · no conversion.**
5. **Limitations.** The reversal succeeded because the seller's (pending) balance covered it. Reversal when the seller
   has already been paid out or has insufficient balance is a Phase 4 failure scenario.
6. **C2C implications.** Between the refund and the reversal, the platform is out 50.00 PLN while the seller still
   holds 45.00 PLN. Refund and reversal must be one tracked business operation, retried until both are done.

### 6b. `refund-after-transfer-destination` — destination charge, refund with `reverse_transfer` and `refund_application_fee`

1. **Business purpose.** The same full refund, under the destination-charge model.
2. **Stripe API calls.** create+confirm (fee 500, destination) → `POST /v1/refunds` (`reverse_transfer: true`, `refund_application_fee: true`).
3. **Expected transitions.** One refund call reverses the transfer and refunds the application fee.
4. **Actual Sandbox results.** **Passed.** PI `pi_3UTiXGKKgVb6y81Y1Mk0khE3` (req_PcRuplLcS9vSnU), charge `ch_3UTiXGKKgVb6y81Y1NbcRhz8`,
   transfer `tr_3UTiXGKKgVb6y81Y1PCKoXXk` 5000 fully reversed by `trr_1UTiXIKKgVb6y81YKXIJSk7V`, fee `fee_1UTiXHKKgVS24coWUJ1ImzEo` 500
   refunded by `fr_1UTiXIKKgVS24coWHAJbnyCm`, refund `re_3UTiXGKKgVb6y81Y1bf7lRKb` `succeeded` with `transfer_reversal` set (req_0ZQulZhyElNnML).

   | Side | Balance transaction | Type | amount / fee / net |
   | --- | --- | --- | --- |
   | Platform | `txn_3UTiXGKKgVb6y81Y1CgjUkel` | charge | 5000 / 263 / 4737 |
   | Platform | `txn_3UTiXGKKgVb6y81Y1zjOwlw4` | transfer | −5000 / 0 / −5000 |
   | Platform | `txn_1UTiXJKKgVb6y81YDyMxSdby` | application_fee | 500 / 0 / 500 |
   | Platform | `txn_1UTiXIKKgVb6y81YyYvcPHfD` | application_fee_refund | −500 / 0 / −500 |
   | Platform | `txn_3UTiXGKKgVb6y81Y1D5pnWoc` | refund | −5000 / 0 / −5000 |
   | Platform | `txn_1UTiXJKKgVb6y81YzvTHKmGD` | transfer_refund | 5000 / 0 / 5000 |
   | Connected | `txn_1UTiXHKKgVS24coWG9JpWB5k` | payment | 5000 / 500 / 4500 |
   | Connected | `txn_1UTiXJKKgVS24coWg1WClwVi` | adjustment (fee refunded to seller) | 500 / 0 / 500 |
   | Connected | `txn_1UTiXJKKgVS24coWw5vrhcAz` | payment_refund (`pyr_1UTiXIKKgVS24coW8M6IeVZD`) | −5000 / 0 / −5000 |

   **Stripe fee 263, not returned · platform net −263 · seller net 0 · no conversion.**
5. **Limitations.** As in 6a, the reversal was covered by the seller's pending balance. Partial refunds were not tested.
6. **C2C implications.** Destination charges make refunds atomic in a single API call. The platform still loses
   Stripe's fee, and its commission is gone if `refund_application_fee` is true.

---

## Platform economics per 50.00 PLN (observed, `pm_card_visa`)

| Outcome | Seller net | Platform net |
| --- | --- | --- |
| Paid, 10% commission (scenarios 1, 2, 4) | 45.00 PLN | **2.37 PLN** |
| Partial 30.00 PLN capture, 10% commission (scenario 3) | 27.00 PLN | **1.02 PLN** |
| Fully refunded (scenarios 5, 6a, 6b) | 0.00 PLN | **−2.63 PLN** |
| Authorization cancelled before capture | 0.00 PLN | **0.00 PLN — verified in Phase 3** (no balance transactions at all; `pi_3UTjMSKKgVb6y81Y1E9JUcwm`) |

## Limitations of this phase

- Nothing settled: every balance transaction is `pending` until 2026-10-30, and no payout was created or observed.
- The Stripe fee rate is inferred from two data points with one US test card. Polish-card pricing and Express
  account fees are not measured.
- Disputes, failed transfers, reversals against an empty seller balance and the direct-charge model are not tested (Phase 4).
- Attribution relies on the lab account being dedicated and scenarios running one after another. Balance
  transactions that already existed when a run started are excluded. A bug in an earlier run (picking up the
  previous scenario's payment) was found and fixed this way; all reported runs show 0 unattributed platform entries.
- No database: the charge↔transfer↔refund links live only in Stripe (`transfer_group`, metadata) and in the JSON evidence.

## How to rerun

`npx vitest run tests/integration/phase2.sandbox.test.ts`. It uses the single connected account tagged
`metadata.lab = stripe-connect-lab` (or `LAB_CONNECTED_ACCOUNT_ID`), checks readiness via Accounts v2 first, and never
creates accounts. Single scenarios: `POST /api/lab/connect/scenarios/<id>` with `{"accountId":"acct_…"}` on `next dev`.
