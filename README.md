# Stripe Connect Deposit Lab

An isolated technical proof of concept for testing Stripe Connect payment, deposit and authorization
mechanisms for a C2C platform. **Stripe Sandbox only. Local development only.** It is not a marketplace application.

## Setup

1. Create `.env.local` **in this project directory** from `.env.example` and set `STRIPE_SECRET_KEY` to a
   Sandbox key (`sk_test_…` or `rk_test_…`). The app refuses live keys.
   A restricted key needs read/write on PaymentIntents (and read on Account for the dashboard header).
2. `npm run dev` and open http://localhost:3000.

## Commands

| Command | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` (run `npx next typegen` first on a clean checkout) |
| `npm run test:unit` | Guard, validation and route tests (no Stripe calls) |
| `npm run test:sandbox` | Runs the Phase 1–3 scenarios against Stripe Sandbox. Skipped if no test key is set |
| `npm test` | Both |

## Layout

- `src/lib/stripe/client.ts` — server-only Stripe client, test-key enforcement.
- `src/lib/lab/` — guard, Zod schemas, operations, summaries, scenario definitions and runner.
- `src/lib/lab/connect/` — Phase 2: lab connected account (Accounts v2), readiness, ledger collection, Connect scenarios.
- `src/app/api/lab/` — local-only route handlers.
- `src/lib/lab/rules.ts`, `financial.ts`, `details.ts` — Phase 3: ownership/state rules, refunds/transfers/reversals/fee refunds, read-only payment details and Events timeline.
- `src/app/_components/` — Polish demonstration dashboard (shell, workspace, details, timeline, expiry simulation, accounts, explainer, history).
- `docs/` — per-phase scenario documentation and Sandbox results.

## Progress

- Phase 1 (PaymentIntents, manual capture): implemented, 4/4 scenarios passed in Sandbox (PLN only) on 2026-10-23. See `docs/phase-1-payment-intents.md`.
- Phase 2 (Stripe Connect): 6 scenarios (7 runs) passed in Sandbox on 2026-10-23 on lab account `acct_1UTi5VKKgVS24coW`. See `docs/phase-2-stripe-connect.md`.
- Phase 3 (Polish demonstration dashboard): implemented; server flows verified in Sandbox on 2026-10-23 (6/6). See `docs/phase-3-dashboard.md`.
  The UI was not exercised by browser automation (Playwright skipped by decision).
- Phases 4–5: not started.
