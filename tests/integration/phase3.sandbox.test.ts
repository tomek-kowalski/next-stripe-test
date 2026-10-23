import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as refundApplicationFee } from "@/app/api/lab/application-fees/[id]/refunds/route";
import { GET as listAccounts } from "@/app/api/lab/connect/accounts/route";
import { GET as balance } from "@/app/api/lab/connect/accounts/[id]/balance/route";
import { POST as cancel } from "@/app/api/lab/payment-intents/[id]/cancel/route";
import { POST as capture } from "@/app/api/lab/payment-intents/[id]/capture/route";
import { POST as confirm } from "@/app/api/lab/payment-intents/[id]/confirm/route";
import { GET as details } from "@/app/api/lab/payment-intents/[id]/details/route";
import { POST as refund } from "@/app/api/lab/payment-intents/[id]/refund/route";
import { POST as create } from "@/app/api/lab/payment-intents/route";
import { POST as transfer } from "@/app/api/lab/transfers/route";
import { POST as reverse } from "@/app/api/lab/transfers/[id]/reversals/route";
import { listLabAccounts } from "@/lib/lab/connect/account";
import type { PaymentDetails } from "@/lib/lab/details";
import { getStripe } from "@/lib/stripe/client";

// Phase 3 dashboard flows, executed through the real route handlers (guard, Zod,
// lab ownership rules) against Stripe Sandbox. Every flow ends by inspecting the actual
// Stripe objects and balance transactions via the details endpoint.
const hasSandboxKey = /^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY ?? "");
const NON_LAB_ACCOUNT = "acct_1UTeTNKKgVaFe2oa";

type Json = Record<string, unknown> & { ok?: boolean; kind?: string; message?: string };
type Handler = (req: Request, ctx: never) => Promise<Response>;

async function call(handler: Handler, method: "GET" | "POST", params: Record<string, string> = {}, body?: unknown) {
  const req = new Request("http://localhost:3000/api/lab", {
    method,
    headers: { host: "localhost:3000", ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handler(req, { params: Promise.resolve(params) } as never);
  return { status: res.status, body: (await res.json()) as Json };
}

const key = () => ({ idempotencyKey: randomUUID() });
const evidence: Record<string, unknown[]> = {};
const log = (flow: string, step: string, r: { status: number; body: Json }) => {
  (evidence[flow] ??= []).push({ step, status: r.status, kind: r.body.kind ?? null, message: r.body.message ?? null, requestId: r.body.requestId ?? null, objectId: r.body.objectId ?? null });
  return r;
};

/** Balance transactions and events are written asynchronously: poll until the predicate holds. */
async function detailsUntil(piId: string, ready: (d: PaymentDetails) => boolean, timeoutMs = 40_000) {
  const t0 = Date.now();
  let d: PaymentDetails;
  do {
    const r = await call(details as Handler, "GET", { id: piId });
    expect(r.status).toBe(200);
    d = r.body as unknown as PaymentDetails;
    if (ready(d)) return d;
    await new Promise((r) => setTimeout(r, 2000));
  } while (Date.now() - t0 < timeoutMs);
  return d;
}

/** Money is conserved: what the customer finally paid = platform net + seller net + Stripe fees. */
const conserved = (d: PaymentDetails) =>
  (d.objects.charge?.amount_captured ?? 0) - (d.objects.charge?.amount_refunded ?? 0) === d.funds.platformNet + d.funds.sellerNet + d.funds.stripeFees;

describe.skipIf(!hasSandboxKey)("Phase 3 dashboard flows against Stripe Sandbox", () => {
  let accountId: string;

  beforeAll(async () => {
    mkdirSync("test-results/sandbox", { recursive: true });
    const lab = await listLabAccounts(getStripe());
    if (lab.length !== 1) throw new Error(`Expected exactly one lab account, found ${lab.length}`);
    accountId = lab[0].id;
  }, 60_000);

  it("lists all connected accounts read-only, with readiness only for the lab account", async () => {
    const r = await call(listAccounts as Handler, "GET");
    expect(r.status).toBe(200);
    const accounts = r.body.accounts as { id: string; isLabAccount: boolean; readiness: { ready: boolean } | null }[];
    expect(accounts.find((a) => a.id === accountId)?.readiness?.ready).toBe(true);
    expect(accounts.find((a) => a.id === NON_LAB_ACCOUNT)).toMatchObject({ isLabAccount: false, readiness: null });
    const b = await call(balance as Handler, "GET", { id: NON_LAB_ACCOUNT });
    expect(b.status).toBe(403);
  }, 60_000);

  it("refuses money movement to a non-lab account and access to non-lab PaymentIntents", async () => {
    const f = "ownership";
    const r = log(f, "create destination to non-lab account", await call(create as Handler, "POST", {}, {
      amount: 5000, chargeModel: "destination", accountId: NON_LAB_ACCOUNT, applicationFeeAmount: 500, ...key(),
    }));
    expect(r.status).toBe(403);
    expect(r.body.kind).toBe("rule");

    // A PaymentIntent without the lab tag (never confirmed, moves no money).
    const foreign = await getStripe().paymentIntents.create({ amount: 5000, currency: "pln", allowed_payment_method_types: ["card"] });
    for (const [label, handler, body] of [
      ["details", details, undefined],
      ["capture", capture, {}],
      ["cancel", cancel, {}],
      ["refund", refund, key()],
    ] as const) {
      const x = log(f, `${label} on non-lab PI ${foreign.id}`, await call(handler as Handler, label === "details" ? "GET" : "POST", { id: foreign.id }, body));
      expect(x.status, label).toBe(403);
    }
    await getStripe().paymentIntents.cancel(foreign.id);
  }, 60_000);

  it("destination charge: authorize, partial capture, refunds, fee refund, manual reversal", async () => {
    const f = "destination";
    const c = log(f, "create", await call(create as Handler, "POST", {}, {
      amount: 5000, chargeModel: "destination", captureMethod: "manual", accountId, applicationFeeAmount: 500, scenario: "phase3-destination", ...key(),
    }));
    expect(c.status).toBe(200);
    const id = (c.body.summary as { id: string }).id;
    expect(log(f, "confirm", await call(confirm as Handler, "POST", { id }, { paymentMethod: "pm_card_visa", ...key() })).body.summary).toMatchObject({ status: "requires_capture" });

    expect(log(f, "capture above capturable (rule)", await call(capture as Handler, "POST", { id }, { amountToCapture: 6000, ...key() })).status).toBe(422);
    const cap = log(f, "capture 3000 fee 300", await call(capture as Handler, "POST", { id }, { amountToCapture: 3000, applicationFeeAmount: 300, ...key() }));
    expect(cap.body.summary).toMatchObject({ status: "succeeded", amount_received: 3000 });

    expect(log(f, "capture again (rule)", await call(capture as Handler, "POST", { id }, key())).status).toBe(409);
    expect(log(f, "cancel after capture (rule)", await call(cancel as Handler, "POST", { id }, key())).status).toBe(409);
    expect(log(f, "manual transfer on destination (rule)", await call(transfer as Handler, "POST", {}, { paymentIntentId: id, amount: 100, ...key() })).status).toBe(422);
    expect(log(f, "refund above refundable (rule)", await call(refund as Handler, "POST", { id }, { amount: 3001, ...key() })).status).toBe(422);

    const re = log(f, "refund 1000 reverse_transfer + refund_application_fee", await call(refund as Handler, "POST", { id }, {
      amount: 1000, reverseTransfer: true, refundApplicationFee: true, ...key(),
    }));
    expect(re.status).toBe(200);

    let d = await detailsUntil(id, (x) => !!x.objects.applicationFee && x.objects.refunds.length === 1 && x.ledger.connected.length >= 3);
    const feeId = d.objects.applicationFee!.id;
    const transferId = d.objects.transfers[0].id;
    expect(log(f, "fee refund above remaining (rule)", await call(refundApplicationFee as Handler, "POST", { id: feeId }, { amount: 1000, ...key() })).status).toBe(422);
    expect(log(f, "application fee refund 100", await call(refundApplicationFee as Handler, "POST", { id: feeId }, { amount: 100, ...key() })).status).toBe(200);
    expect(log(f, "manual reversal 500 of destination transfer", await call(reverse as Handler, "POST", { id: transferId }, { amount: 500, ...key() })).status).toBe(200);

    // Seller: 3000 − 300 fee + 100 fee refunded by refund + 100 fee refund − 1000 refund reversal − 500 manual reversal = 1400.
    d = await detailsUntil(id, (x) => x.funds.sellerNet === 1400 && x.objects.transferReversals.length === 2 && x.timeline.some((e) => e.type === "charge.refunded"));
    writeFileSync("test-results/sandbox/phase3-destination-details.json", JSON.stringify(d, null, 2));
    expect(d.funds.sellerNet).toBe(1400);
    expect(d.funds.applicationFeeNet).toBe(100); // 300 − 100 (proportional, with the refund) − 100 (explicit)
    expect(d.funds.transferredToSeller).toBe(1500); // 3000 − 1000 − 500
    expect(conserved(d)).toBe(true);
    expect(d.funds.currencyConversion).toBe(false);
    expect(d.timeline.every((e) => !Number.isNaN(Date.parse(e.at_iso)))).toBe(true);
  }, 180_000);

  it("separate charges and transfers: transfer, over-transfer refused, reversals, refund", async () => {
    const f = "separate";
    const c = log(f, "create", await call(create as Handler, "POST", {}, {
      amount: 5000, chargeModel: "separate", captureMethod: "automatic", accountId, scenario: "phase3-separate", ...key(),
    }));
    expect(c.status).toBe(200);
    const id = (c.body.summary as { id: string }).id;
    expect(log(f, "confirm", await call(confirm as Handler, "POST", { id }, { paymentMethod: "pm_card_visa", ...key() })).body.summary).toMatchObject({ status: "succeeded" });

    const t = log(f, "transfer 4500", await call(transfer as Handler, "POST", {}, { paymentIntentId: id, amount: 4500, ...key() }));
    expect(t.status).toBe(200);
    const transferId = t.body.objectId as string;
    expect(log(f, "transfer 1000 more (rule: only 500 left)", await call(transfer as Handler, "POST", {}, { paymentIntentId: id, amount: 1000, ...key() })).status).toBe(422);
    expect(log(f, "refund with reverse_transfer on separate (rule)", await call(refund as Handler, "POST", { id }, { reverseTransfer: true, ...key() })).status).toBe(422);

    expect(log(f, "reverse 1500", await call(reverse as Handler, "POST", { id: transferId }, { amount: 1500, ...key() })).status).toBe(200);
    expect(log(f, "refund full", await call(refund as Handler, "POST", { id }, key())).status).toBe(200);
    expect(log(f, "reverse remaining", await call(reverse as Handler, "POST", { id: transferId }, key())).status).toBe(200);
    expect(log(f, "reverse again (rule)", await call(reverse as Handler, "POST", { id: transferId }, key())).status).toBe(409);

    const d = await detailsUntil(id, (x) => x.funds.sellerNet === 0 && x.objects.transferReversals.length === 2 && x.ledger.platform.some((e) => e.type === "refund"));
    writeFileSync("test-results/sandbox/phase3-separate-details.json", JSON.stringify(d, null, 2));
    expect(d.funds.sellerNet).toBe(0);
    expect(d.funds.transferredToSeller).toBe(0);
    expect(d.funds.platformNet).toBe(-d.funds.stripeFees);
    expect(conserved(d)).toBe(true);
  }, 180_000);

  it("platform-only authorization cancelled: no balance transactions at all", async () => {
    const f = "cancel";
    const c = log(f, "create", await call(create as Handler, "POST", {}, { amount: 5000, scenario: "phase3-cancel", ...key() }));
    const id = (c.body.summary as { id: string }).id;
    log(f, "confirm", await call(confirm as Handler, "POST", { id }, { paymentMethod: "pm_card_visa", ...key() }));
    expect(log(f, "refund before capture (rule)", await call(refund as Handler, "POST", { id }, key())).status).toBe(409);
    expect(log(f, "cancel", await call(cancel as Handler, "POST", { id }, key())).body.summary).toMatchObject({ status: "canceled" });

    const d = await detailsUntil(id, (x) => x.timeline.some((e) => e.type === "payment_intent.canceled"));
    writeFileSync("test-results/sandbox/phase3-cancel-details.json", JSON.stringify(d, null, 2));
    expect(d.ledger.platform).toEqual([]);
    expect(d.ledger.connected).toEqual([]);
    expect(d.funds.platformNet).toBe(0);
    expect(d.authorizationDeadline).toBeNull();
  }, 120_000);

  it("writes evidence", () => {
    writeFileSync("test-results/sandbox/phase3-steps.json", JSON.stringify(evidence, null, 2));
  });
});
