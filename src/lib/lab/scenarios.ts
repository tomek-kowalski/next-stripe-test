import type {
  CancelPaymentIntentBody,
  CapturePaymentIntentBody,
  ConfirmPaymentIntentBody,
  CreatePaymentIntentInput,
  TestPaymentMethod,
} from "./schemas";
import type { PaymentIntentSummary } from "./summary";
import type { OperationName, OperationResult } from "./types";

// Client-safe: no Stripe client here. Scenarios run through an Executor, which is
// HTTP (dashboard → API routes) or direct SDK calls (integration tests).

export type ScenarioContext = {
  amount: number;
  partialAmount: number;
  paymentMethod: TestPaymentMethod;
};

export type Check = {
  label: string;
  /** Informational checks record an observed value without asserting it. */
  kind: "assert" | "info";
  pass: boolean;
  expected?: unknown;
  actual: unknown;
};

type StepDef = {
  op: OperationName;
  capture?: "full" | "partial";
  checks: (s: PaymentIntentSummary, ctx: ScenarioContext) => Check[];
};

export type Scenario = {
  id: string;
  title: string;
  purpose: string;
  steps: StepDef[];
};

export interface Executor {
  create(body: CreatePaymentIntentInput): Promise<OperationResult>;
  confirm(id: string, body: ConfirmPaymentIntentBody): Promise<OperationResult>;
  retrieve(id: string): Promise<OperationResult>;
  capture(id: string, body: CapturePaymentIntentBody): Promise<OperationResult>;
  cancel(id: string, body: CancelPaymentIntentBody): Promise<OperationResult>;
}

export type StepResult = { op: OperationName; label: string; result: OperationResult; checks: Check[] };

export type ScenarioRun = {
  scenarioId: string;
  paymentIntentId: string | null;
  passed: boolean;
  steps: StepResult[];
  error: string | null;
};

const eq = (label: string, actual: unknown, expected: unknown): Check => ({
  label,
  kind: "assert",
  pass: Object.is(actual, expected),
  expected,
  actual,
});

const info = (label: string, actual: unknown): Check => ({ label, kind: "info", pass: true, actual });

const authorizationInfo = (s: PaymentIntentSummary): Check[] => [
  info("charge.payment_method_details.card.capture_before", s.charge?.authorization?.capture_before_iso ?? null),
  info(
    "hours until capture_before",
    s.charge?.authorization?.capture_before
      ? Math.round((s.charge.authorization.capture_before * 1000 - Date.now()) / 36e5)
      : null,
  ),
  info("extended_authorization.status", s.charge?.authorization?.extended_authorization_status ?? null),
];

const created: StepDef = {
  op: "create",
  checks: (s, ctx) => [
    eq("status", s.status, "requires_payment_method"),
    eq("capture_method", s.capture_method, "manual"),
    eq("currency", s.currency, "pln"),
    eq("amount", s.amount, ctx.amount),
    eq("livemode", s.livemode, false),
  ],
};

const authorized: StepDef = {
  op: "confirm",
  checks: (s, ctx) => [
    eq("status", s.status, "requires_capture"),
    eq("amount_capturable", s.amount_capturable, ctx.amount),
    eq("amount_received", s.amount_received, 0),
    eq("charge.captured", s.charge?.captured, false),
    eq("charge.amount_authorized", s.charge?.authorization?.amount_authorized, ctx.amount),
    ...authorizationInfo(s),
  ],
};

const fullyCaptured = (s: PaymentIntentSummary, ctx: ScenarioContext): Check[] => [
  eq("status", s.status, "succeeded"),
  eq("amount_received", s.amount_received, ctx.amount),
  eq("amount_capturable", s.amount_capturable, 0),
  eq("charge.captured", s.charge?.captured, true),
  eq("charge.amount_captured", s.charge?.amount_captured, ctx.amount),
  eq("charge.amount_refunded", s.charge?.amount_refunded, 0),
];

const partiallyCaptured = (s: PaymentIntentSummary, ctx: ScenarioContext): Check[] => [
  eq("status", s.status, "succeeded"),
  eq("amount_received", s.amount_received, ctx.partialAmount),
  eq("amount_capturable", s.amount_capturable, 0),
  eq("charge.amount_captured", s.charge?.amount_captured, ctx.partialAmount),
  // Observed in Sandbox on API 2026-09-30.endive: the uncaptured remainder is released
  // silently. It is NOT reported as a refund (amount_refunded stays 0, no Refund object);
  // the only signal is charge.amount − charge.amount_captured with amount_capturable = 0.
  eq("charge.amount_refunded (remainder is not a refund)", s.charge?.amount_refunded, 0),
  eq("released remainder (charge.amount − amount_captured)", (s.charge?.amount ?? 0) - (s.charge?.amount_captured ?? 0), ctx.amount - ctx.partialAmount),
  info("charge.refunded", s.charge?.refunded),
];

const canceled = (s: PaymentIntentSummary, ctx: ScenarioContext): Check[] => [
  eq("status", s.status, "canceled"),
  eq("cancellation_reason", s.cancellation_reason, "requested_by_customer"),
  eq("amount_received", s.amount_received, 0),
  eq("amount", s.amount, ctx.amount),
  info("amount_capturable", s.amount_capturable),
  info("charge.captured", s.charge?.captured),
  info("charge.amount_refunded", s.charge?.amount_refunded),
  info("charge.refunded", s.charge?.refunded),
];

export const PHASE_1_SCENARIOS: Scenario[] = [
  {
    id: "authorize-inspect",
    title: "Authorize and inspect expiration",
    purpose: "Place a deposit hold and read how long it stays valid (capture_before).",
    steps: [created, authorized, { op: "retrieve", checks: (s, ctx) => authorized.checks(s, ctx) }],
  },
  {
    id: "capture-full",
    title: "Authorize → capture full amount",
    purpose: "Charge the entire held deposit (e.g. full damage claim).",
    steps: [
      created,
      authorized,
      { op: "capture", capture: "full", checks: fullyCaptured },
      { op: "retrieve", checks: fullyCaptured },
    ],
  },
  {
    id: "capture-partial",
    title: "Authorize → capture partial amount",
    purpose: "Charge part of the deposit and release the rest of the hold.",
    steps: [
      created,
      authorized,
      { op: "capture", capture: "partial", checks: partiallyCaptured },
      { op: "retrieve", checks: partiallyCaptured },
    ],
  },
  {
    id: "cancel-authorization",
    title: "Authorize → cancel (release hold)",
    purpose: "Release the whole deposit hold without charging (no damage).",
    steps: [created, authorized, { op: "cancel", checks: canceled }, { op: "retrieve", checks: canceled }],
  },
];

export function validateContext(ctx: ScenarioContext): string | null {
  if (!Number.isInteger(ctx.amount) || ctx.amount < 1) return "Amount must be a positive integer in minor units.";
  if (!Number.isInteger(ctx.partialAmount) || ctx.partialAmount < 1 || ctx.partialAmount >= ctx.amount) {
    return "Partial amount must be a positive integer smaller than the amount.";
  }
  return null;
}

/** Runs one scenario on a fresh PaymentIntent and stops at the first failed request. */
export async function runScenario(
  scenario: Scenario,
  ctx: ScenarioContext,
  exec: Executor,
  onStep?: (step: StepResult) => void,
): Promise<ScenarioRun> {
  const run: ScenarioRun = { scenarioId: scenario.id, paymentIntentId: null, passed: false, steps: [], error: null };
  const invalid = validateContext(ctx);
  if (invalid) return { ...run, error: invalid };

  for (const step of scenario.steps) {
    const id = run.paymentIntentId;
    let result: OperationResult;
    let label: string = step.op;
    if (step.op === "create") {
      result = await exec.create({ amount: ctx.amount, scenario: scenario.id });
    } else if (!id) {
      return { ...run, error: "No PaymentIntent was created." };
    } else if (step.op === "confirm") {
      result = await exec.confirm(id, { paymentMethod: ctx.paymentMethod });
    } else if (step.op === "capture") {
      const partial = step.capture === "partial";
      label = partial ? `capture ${ctx.partialAmount}` : "capture full";
      result = await exec.capture(id, partial ? { amountToCapture: ctx.partialAmount } : {});
    } else if (step.op === "cancel") {
      result = await exec.cancel(id, { cancellationReason: "requested_by_customer" });
    } else {
      result = await exec.retrieve(id);
    }

    const checks = result.ok ? step.checks(result.summary, ctx) : [];
    const stepResult: StepResult = { op: step.op, label, result, checks };
    run.steps.push(stepResult);
    onStep?.(stepResult);

    if (result.ok && step.op === "create") run.paymentIntentId = result.summary.id;
    if (!result.ok) return { ...run, error: `${label} failed: ${result.message}` };
  }

  run.passed = run.steps.every((s) => s.checks.every((c) => c.pass));
  return run;
}
