import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  cancelPaymentIntent,
  capturePaymentIntent,
  confirmPaymentIntent,
  createPaymentIntent,
  retrievePaymentIntent,
} from "@/lib/lab/operations";
import { PHASE_1_SCENARIOS, runScenario, type Executor, type ScenarioContext } from "@/lib/lab/scenarios";
import { CreatePaymentIntentBodySchema } from "@/lib/lab/schemas";
import { getStripe } from "@/lib/stripe/client";

// Runs against the real Stripe Sandbox. Skipped (and reported as skipped) unless a
// test-mode key is configured in this project's .env.local.
const hasSandboxKey = /^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY ?? "");

describe.skipIf(!hasSandboxKey)("Phase 1 scenarios against Stripe Sandbox", () => {
  const ctx: ScenarioContext = {
    amount: 5000,
    partialAmount: 2000,
    paymentMethod: "pm_card_visa",
  };

  const direct = (): Executor => {
    const stripe = getStripe();
    return {
      create: (b) => createPaymentIntent(stripe, CreatePaymentIntentBodySchema.parse(b)),
      confirm: (id, b) => confirmPaymentIntent(stripe, id, b),
      retrieve: (id) => retrievePaymentIntent(stripe, id),
      capture: (id, b) => capturePaymentIntent(stripe, id, b),
      cancel: (id, b) => cancelPaymentIntent(stripe, id, b),
    };
  };

  for (const scenario of PHASE_1_SCENARIOS) {
    it(scenario.id, async () => {
      const run = await runScenario(scenario, ctx, direct());
      // Print the evidence (IDs, request IDs, observed values) for the results log.
      const evidence = {
        scenario: run.scenarioId,
        paymentIntent: run.paymentIntentId,
        passed: run.passed,
        error: run.error,
        steps: run.steps.map((s) => ({
          step: s.label,
          requestId: s.result.requestId,
          status: s.result.ok ? s.result.summary.status : `ERROR ${s.result.httpStatus} ${s.result.message}`,
          checks: s.checks.map(
            (c) =>
              `${c.kind === "info" ? "info" : c.pass ? "PASS" : "FAIL"} ${c.label}=${JSON.stringify(c.actual)}` +
              (c.pass ? "" : ` expected ${JSON.stringify(c.expected)}`),
          ),
        })),
      };
      console.log(JSON.stringify(evidence, null, 2));
      mkdirSync("test-results/sandbox", { recursive: true });
      writeFileSync(`test-results/sandbox/${scenario.id}.json`, JSON.stringify({ at: new Date().toISOString(), ...evidence }, null, 2));
      expect(run.error).toBeNull();
      expect(run.passed).toBe(true);
    });
  }
});
