import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { checkAccountReadiness, type AccountReadiness } from "./account";
import { collectLedger, snapshotLedger, type Ledger } from "./ledger";
import { describeError, type ConnectErrorBody } from "./route";

// Phase 2: each scenario creates its own PaymentIntent (and transfers/refunds) on the
// tagged lab connected account, then collects the balance transactions it produced on
// both sides. Amounts are PLN grosze.

export const AMOUNT = 5000; // 50.00 PLN
export const APPLICATION_FEE = 500; // 5.00 PLN
export const TRANSFER_AMOUNT = 4500; // 45.00 PLN
export const PARTIAL_CAPTURE = 3000; // 30.00 PLN
export const PARTIAL_APPLICATION_FEE = 300; // 3.00 PLN, the same 10% as the full fee

export type Step = {
  label: string;
  ok: boolean;
  /** The step was expected to be able to fail; its outcome is a finding either way. */
  probe: boolean;
  requestId: string | null;
  idempotencyKey: string | null;
  objectId: string | null;
  status: string | null;
  error: ConnectErrorBody | null;
  raw: unknown;
};

export type Check = { label: string; kind: "assert" | "info"; pass: boolean; expected?: unknown; actual: unknown };

export type ScenarioObjects = {
  paymentIntent: { id: string; status: string; amount: number; amount_received: number; capture_method: string } | null;
  charge: {
    id: string;
    status: string;
    captured: boolean;
    amount: number;
    amount_captured: number;
    amount_refunded: number;
    refunded: boolean;
    transfer_group: string | null;
    destination: string | null;
  } | null;
  transfers: { id: string; amount: number; amount_reversed: number; reversed: boolean; destination_payment: string | null; source_transaction: string | null }[];
  transferReversals: { id: string; transfer: string; amount: number }[];
  applicationFee: { id: string; amount: number; amount_refunded: number; refunded: boolean; refundIds: string[] } | null;
  refunds: { id: string; status: string | null; amount: number; transfer_reversal: string | null }[];
};

export type ConnectScenarioRun = {
  scenarioId: string;
  title: string;
  chargeModel: "destination" | "separate";
  accountId: string;
  startedAt: string;
  passed: boolean;
  error: string | null;
  readiness: AccountReadiness | null;
  steps: Step[];
  objects: ScenarioObjects;
  ledger: Ledger | null;
  checks: Check[];
  /** Platform net revenue the scenario should produce before Stripe fees. */
  expected: { platformGrossBeforeStripeFees: number; connectedNet: number };
};

class ScenarioAbort extends Error {}

class Recorder {
  readonly steps: Step[] = [];

  async call<T extends { id: string }>(
    label: string,
    fn: (idempotencyKey: string) => Promise<Stripe.Response<T>>,
    { status, probe = false }: { status?: (t: T) => string | null; probe?: boolean } = {},
  ): Promise<T | null> {
    const idempotencyKey = randomUUID();
    try {
      const result = await fn(idempotencyKey);
      this.steps.push({
        label,
        ok: true,
        probe,
        requestId: result.lastResponse?.requestId ?? null,
        idempotencyKey,
        objectId: result.id,
        status: status?.(result) ?? null,
        error: null,
        raw: result,
      });
      return result;
    } catch (error) {
      const { body } = describeError(error);
      this.steps.push({ label, ok: false, probe, requestId: body.requestId, idempotencyKey, objectId: null, status: null, error: body, raw: body.raw });
      if (!probe) throw new ScenarioAbort(`${label} failed: ${body.message}`);
      return null;
    }
  }
}

type Ctx = { stripe: Stripe; accountId: string; rec: Recorder; tag: Record<string, string> };

const card = { payment_method: "pm_card_visa", allowed_payment_method_types: ["card"], confirm: true } as const;

function createPaymentIntent(ctx: Ctx, label: string, params: Partial<Stripe.PaymentIntentCreateParams>) {
  return ctx.rec.call(
    label,
    (idempotencyKey) =>
      ctx.stripe.paymentIntents.create(
        { amount: AMOUNT, currency: "pln", ...card, metadata: ctx.tag, ...params } as Stripe.PaymentIntentCreateParams,
        { idempotencyKey },
      ),
    { status: (pi) => pi.status },
  );
}

const chargeIdOf = (pi: Stripe.PaymentIntent) => (typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id) ?? null;

function transfer(ctx: Ctx, label: string, chargeId: string, transferGroup: string, opts: { probe?: boolean } = {}) {
  return ctx.rec.call(
    label,
    (idempotencyKey) =>
      ctx.stripe.transfers.create(
        {
          amount: TRANSFER_AMOUNT,
          currency: "pln",
          destination: ctx.accountId,
          // Ties the transfer to the charge's funds, so it does not need available platform balance.
          source_transaction: chargeId,
          transfer_group: transferGroup,
          metadata: ctx.tag,
        },
        { idempotencyKey },
      ),
    { probe: opts.probe, status: (t) => (t.reversed ? "reversed" : "created") },
  );
}

type Definition = {
  id: string;
  title: string;
  chargeModel: "destination" | "separate";
  expected: ConnectScenarioRun["expected"];
  run: (ctx: Ctx) => Promise<{ paymentIntentId: string | null }>;
};

export const PHASE_2_SCENARIOS: Definition[] = [
  {
    id: "destination-application-fee",
    title: "1. Destination charge 50.00 PLN with 5.00 PLN application fee",
    chargeModel: "destination",
    expected: { platformGrossBeforeStripeFees: APPLICATION_FEE, connectedNet: AMOUNT - APPLICATION_FEE },
    async run(ctx) {
      const pi = await createPaymentIntent(ctx, "create+confirm (automatic capture)", {
        application_fee_amount: APPLICATION_FEE,
        transfer_data: { destination: ctx.accountId },
      });
      return { paymentIntentId: pi!.id };
    },
  },
  {
    id: "destination-manual-full-capture",
    title: "2. Destination charge, manual authorization, full capture",
    chargeModel: "destination",
    expected: { platformGrossBeforeStripeFees: APPLICATION_FEE, connectedNet: AMOUNT - APPLICATION_FEE },
    async run(ctx) {
      const pi = await createPaymentIntent(ctx, "create+confirm (manual capture)", {
        capture_method: "manual",
        application_fee_amount: APPLICATION_FEE,
        transfer_data: { destination: ctx.accountId },
      });
      await ctx.rec.call(
        "retrieve charge after authorization (expect no transfer yet)",
        () => ctx.stripe.charges.retrieve(chargeIdOf(pi!)!),
        { status: (c) => `captured=${c.captured} transfer=${c.transfer ?? "none"}` },
      );
      await ctx.rec.call("capture full", (idempotencyKey) => ctx.stripe.paymentIntents.capture(pi!.id, {}, { idempotencyKey }), {
        status: (p) => p.status,
      });
      return { paymentIntentId: pi!.id };
    },
  },
  {
    id: "destination-manual-partial-capture",
    title: "3. Destination charge, manual authorization, partial capture 30.00 PLN",
    chargeModel: "destination",
    expected: { platformGrossBeforeStripeFees: PARTIAL_APPLICATION_FEE, connectedNet: PARTIAL_CAPTURE - PARTIAL_APPLICATION_FEE },
    async run(ctx) {
      const pi = await createPaymentIntent(ctx, "create+confirm (manual capture)", {
        capture_method: "manual",
        application_fee_amount: APPLICATION_FEE,
        transfer_data: { destination: ctx.accountId },
      });
      // The fee set at creation (5.00) would exceed 10% of the captured amount; the fee is
      // re-set at capture time to keep the platform's 10% take.
      await ctx.rec.call(
        `capture ${PARTIAL_CAPTURE} with application_fee_amount ${PARTIAL_APPLICATION_FEE}`,
        (idempotencyKey) =>
          ctx.stripe.paymentIntents.capture(
            pi!.id,
            { amount_to_capture: PARTIAL_CAPTURE, application_fee_amount: PARTIAL_APPLICATION_FEE },
            { idempotencyKey },
          ),
        { status: (p) => p.status },
      );
      return { paymentIntentId: pi!.id };
    },
  },
  {
    id: "separate-charge-transfer",
    title: "4. Separate charge 50.00 PLN on the platform, then 45.00 PLN transfer",
    chargeModel: "separate",
    expected: { platformGrossBeforeStripeFees: AMOUNT - TRANSFER_AMOUNT, connectedNet: TRANSFER_AMOUNT },
    async run(ctx) {
      const group = `lab-${randomUUID()}`;
      const pi = await createPaymentIntent(ctx, "create+confirm platform charge", { transfer_group: group });
      await transfer(ctx, `transfer ${TRANSFER_AMOUNT} (source_transaction)`, chargeIdOf(pi!)!, group);
      return { paymentIntentId: pi!.id };
    },
  },
  {
    id: "refund-before-transfer",
    title: "5. Separate charge refunded before any transfer",
    chargeModel: "separate",
    expected: { platformGrossBeforeStripeFees: 0, connectedNet: 0 },
    async run(ctx) {
      const group = `lab-${randomUUID()}`;
      const pi = await createPaymentIntent(ctx, "create+confirm platform charge", { transfer_group: group });
      await ctx.rec.call(
        "refund full",
        (idempotencyKey) => ctx.stripe.refunds.create({ payment_intent: pi!.id, metadata: ctx.tag }, { idempotencyKey }),
        { status: (r) => r.status ?? null },
      );
      // Probe: does Stripe still allow a transfer funded by the refunded charge?
      const late = await transfer(ctx, "probe: transfer after refund (source_transaction)", chargeIdOf(pi!)!, group, { probe: true });
      if (late) {
        // Keep the scenario's money flow clean if Stripe allowed it.
        await ctx.rec.call("reverse the unexpected transfer", (idempotencyKey) =>
          ctx.stripe.transfers.createReversal(late.id, { metadata: ctx.tag }, { idempotencyKey }),
        );
      }
      return { paymentIntentId: pi!.id };
    },
  },
  {
    id: "refund-after-transfer-separate",
    title: "6a. Separate charge + transfer, then refund and transfer reversal",
    chargeModel: "separate",
    expected: { platformGrossBeforeStripeFees: 0, connectedNet: 0 },
    async run(ctx) {
      const group = `lab-${randomUUID()}`;
      const pi = await createPaymentIntent(ctx, "create+confirm platform charge", { transfer_group: group });
      const tr = await transfer(ctx, `transfer ${TRANSFER_AMOUNT} (source_transaction)`, chargeIdOf(pi!)!, group);
      await ctx.rec.call(
        "refund full (platform balance)",
        (idempotencyKey) => ctx.stripe.refunds.create({ payment_intent: pi!.id, metadata: ctx.tag }, { idempotencyKey }),
        { status: (r) => r.status ?? null },
      );
      await ctx.rec.call(
        `reverse transfer ${TRANSFER_AMOUNT}`,
        (idempotencyKey) => ctx.stripe.transfers.createReversal(tr!.id, { metadata: ctx.tag }, { idempotencyKey }),
      );
      return { paymentIntentId: pi!.id };
    },
  },
  {
    id: "refund-after-transfer-destination",
    title: "6b. Destination charge, then refund with reverse_transfer and refund_application_fee",
    chargeModel: "destination",
    expected: { platformGrossBeforeStripeFees: 0, connectedNet: 0 },
    async run(ctx) {
      const pi = await createPaymentIntent(ctx, "create+confirm (automatic capture)", {
        application_fee_amount: APPLICATION_FEE,
        transfer_data: { destination: ctx.accountId },
      });
      await ctx.rec.call(
        "refund full, reverse_transfer + refund_application_fee",
        (idempotencyKey) =>
          ctx.stripe.refunds.create(
            { payment_intent: pi!.id, reverse_transfer: true, refund_application_fee: true, metadata: ctx.tag },
            { idempotencyKey },
          ),
        { status: (r) => r.status ?? null },
      );
      return { paymentIntentId: pi!.id };
    },
  },
];

/**
 * Observed in Sandbox: for a captured destination charge, charge.transfer and
 * charge.application_fee are created asynchronously, seconds after the PaymentIntent
 * reports `succeeded`. Poll until they exist (up to 30 s) and report how long it took.
 */
export async function gatherObjects(
  stripe: Stripe,
  paymentIntentId: string,
  { waitForTransfer = true }: { waitForTransfer?: boolean } = {},
): Promise<{ objects: ScenarioObjects; waitedMs: number | null }> {
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  const chargeId = chargeIdOf(pi);
  const expand = ["transfer", "application_fee", "application_fee.refunds", "refunds"];
  let charge = chargeId ? await stripe.charges.retrieve(chargeId, { expand }) : null;
  const t0 = Date.now();
  let waitedMs: number | null = null;
  const awaitsTransfer = (c: Stripe.Charge) =>
    c.captured && !!c.transfer_data?.destination && (!c.transfer || (c.application_fee_amount !== null && !c.application_fee));
  if (waitForTransfer && charge && awaitsTransfer(charge)) {
    while (Date.now() - t0 < 30_000 && awaitsTransfer(charge)) {
      await new Promise((r) => setTimeout(r, 1000));
      charge = await stripe.charges.retrieve(charge.id, { expand });
    }
    waitedMs = Date.now() - t0;
  }

  const transfers: Stripe.Transfer[] = [];
  if (charge?.transfer && typeof charge.transfer === "object") transfers.push(charge.transfer);
  if (charge?.transfer_group) {
    for await (const t of stripe.transfers.list({ transfer_group: charge.transfer_group, limit: 100 })) {
      if (!transfers.some((x) => x.id === t.id)) transfers.push(t);
    }
  }
  const fee = charge?.application_fee && typeof charge.application_fee === "object" ? charge.application_fee : null;
  const id = (x: string | { id: string } | null | undefined) => (typeof x === "string" ? x : (x?.id ?? null));

  const objects: ScenarioObjects = {
    paymentIntent: { id: pi.id, status: pi.status, amount: pi.amount, amount_received: pi.amount_received, capture_method: pi.capture_method },
    charge: charge && {
      id: charge.id,
      status: charge.status,
      captured: charge.captured,
      amount: charge.amount,
      amount_captured: charge.amount_captured,
      amount_refunded: charge.amount_refunded,
      refunded: charge.refunded,
      transfer_group: charge.transfer_group ?? null,
      destination: id(charge.transfer_data?.destination),
    },
    transfers: transfers.map((t) => ({
      id: t.id,
      amount: t.amount,
      amount_reversed: t.amount_reversed,
      reversed: t.reversed,
      destination_payment: id(t.destination_payment),
      source_transaction: id(t.source_transaction),
    })),
    transferReversals: transfers.flatMap((t) => t.reversals.data.map((r) => ({ id: r.id, transfer: t.id, amount: r.amount }))),
    applicationFee: fee && {
      id: fee.id,
      amount: fee.amount,
      amount_refunded: fee.amount_refunded,
      refunded: fee.refunded,
      refundIds: fee.refunds.data.map((r) => r.id),
    },
    refunds: (charge?.refunds?.data ?? []).map((r) => ({
      id: r.id,
      status: r.status ?? null,
      amount: r.amount,
      transfer_reversal: id(r.transfer_reversal),
    })),
  };
  return { objects, waitedMs };
}

const EMPTY_OBJECTS: ScenarioObjects = {
  paymentIntent: null,
  charge: null,
  transfers: [],
  transferReversals: [],
  applicationFee: null,
  refunds: [],
};

export async function runConnectScenario(stripe: Stripe, scenarioId: string, accountId: string): Promise<ConnectScenarioRun> {
  const def = PHASE_2_SCENARIOS.find((s) => s.id === scenarioId);
  if (!def) throw new Error(`Unknown scenario ${scenarioId}`);

  const startedAt = new Date();
  const since = Math.floor(startedAt.getTime() / 1000) - 2;
  const rec = new Recorder();
  const run: ConnectScenarioRun = {
    scenarioId: def.id,
    title: def.title,
    chargeModel: def.chargeModel,
    accountId,
    startedAt: startedAt.toISOString(),
    passed: false,
    error: null,
    readiness: null,
    steps: rec.steps,
    objects: EMPTY_OBJECTS,
    ledger: null,
    checks: [],
    expected: def.expected,
  };

  run.readiness = await checkAccountReadiness(stripe, accountId);
  if (!run.readiness.ready) return { ...run, error: `Connected account not ready: ${run.readiness.reasons.join("; ")}` };
  const preexisting = await snapshotLedger(stripe, accountId, since);

  let paymentIntentId: string | null = null;
  try {
    ({ paymentIntentId } = await def.run({ stripe, accountId, rec, tag: { lab: "stripe-connect-lab", phase: "2", scenario: def.id } }));
  } catch (error) {
    if (!(error instanceof ScenarioAbort)) throw error;
    run.error = error.message;
  }
  paymentIntentId ??= rec.steps.find((s) => s.objectId?.startsWith("pi_"))?.objectId ?? null;
  if (!paymentIntentId) return run;

  const gathered = await gatherObjects(stripe, paymentIntentId);
  run.objects = gathered.objects;
  const o = run.objects;
  const sources = new Set(
    [
      o.charge?.id,
      ...o.transfers.map((t) => t.id),
      ...o.transferReversals.map((r) => r.id),
      o.applicationFee?.id,
      ...(o.applicationFee?.refundIds ?? []),
      ...o.refunds.map((r) => r.id),
    ].filter((x): x is string => !!x),
  );
  run.ledger = await collectLedger(stripe, { connectedAccountId: accountId, since, sources, exclude: preexisting });

  const { platformTotals: p, connectedTotals: c } = run.ledger;
  const eq = (label: string, actual: unknown, expected: unknown): Check => ({ label, kind: "assert", pass: Object.is(actual, expected), expected, actual });
  const info = (label: string, actual: unknown): Check => ({ label, kind: "info", pass: true, actual });
  run.checks = [
    eq("connected account net allocation", c.net, def.expected.connectedNet),
    eq("platform net = expected gross − Stripe fees", p.net, def.expected.platformGrossBeforeStripeFees - p.stripeFees),
    eq("no currency conversion (platform)", p.currencyConversion, false),
    eq("no currency conversion (connected)", c.currencyConversion, false),
    eq("no unattributed platform balance transactions", run.ledger.unattributedPlatform.length, 0),
    info("ms waited for destination transfer/application fee to appear on the charge", gathered.waitedMs),
    info("Stripe processing fees (platform, net of fee refunds)", p.stripeFees),
    info("platform net revenue", p.net),
    info("platform pending / available net", `${p.pendingNet} / ${p.availableNet}`),
    info("connected pending / available net", `${c.pendingNet} / ${c.availableNet}`),
  ];
  run.passed = !run.error && run.checks.every((ch) => ch.pass);
  return run;
}
