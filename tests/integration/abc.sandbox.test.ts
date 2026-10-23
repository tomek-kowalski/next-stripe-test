import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { GET as bookings } from "@/app/api/lab/bookings/route";
import { POST as capture } from "@/app/api/lab/payment-intents/[id]/capture/route";
import { POST as confirm } from "@/app/api/lab/payment-intents/[id]/confirm/route";
import { GET as details } from "@/app/api/lab/payment-intents/[id]/details/route";
import { POST as create } from "@/app/api/lab/payment-intents/route";
import { POST as transfer } from "@/app/api/lab/transfers/route";
import type { BookingListItem } from "@/lib/lab/bookings";
import { listLabAccounts } from "@/lib/lab/connect/account";
import type { PaymentDetails } from "@/lib/lab/details";
import { getStripe } from "@/lib/stripe/client";

// Scenarios A/B/C on one shared booking, through the real route handlers, against
// Stripe Sandbox. 100 zł payment, 10 zł platform fee, 90 zł for the seller.
const hasSandboxKey = /^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY ?? "");

type Json = Record<string, unknown> & { ok?: boolean };
type Handler = (req: Request, ctx: never) => Promise<Response>;

async function call(handler: Handler, method: "GET" | "POST", params: Record<string, string> = {}, body?: unknown, url = "http://localhost:3000/api/lab") {
  const req = new Request(url, {
    method,
    headers: { host: "localhost:3000", ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handler(req, { params: Promise.resolve(params) } as never);
  return { status: res.status, body: (await res.json()) as Json };
}

async function detailsUntil(id: string, ready: (d: PaymentDetails) => boolean, timeoutMs = 40_000) {
  const t0 = Date.now();
  let d: PaymentDetails;
  do {
    d = (await call(details as Handler, "GET", { id })).body as unknown as PaymentDetails;
    if (ready(d)) return d;
    await new Promise((r) => setTimeout(r, 2000));
  } while (Date.now() - t0 < timeoutMs);
  return d;
}

const key = () => ({ idempotencyKey: randomUUID() });
const bookingId = `bk_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const booking = (scenario: "A" | "B" | "C") => ({ id: bookingId, scenario, item: "Wiertarka udarowa", customer: "Klient testowy", start: "2026-10-24", end: "2026-10-27" });
const evidence: Record<string, unknown> = { bookingId };

describe.skipIf(!hasSandboxKey)("Scenarios A/B/C on a shared booking (Stripe Sandbox)", () => {
  let accountId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    mkdirSync("test-results/sandbox", { recursive: true });
    accountId = (await listLabAccounts(getStripe()))[0].id;
  }, 60_000);

  async function start(scenario: "A" | "B" | "C", body: Record<string, unknown>) {
    const c = await call(create as Handler, "POST", {}, { amount: 10000, accountId, booking: booking(scenario), scenario: `abc-${scenario.toLowerCase()}`, ...body, ...key() });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const id = (c.body.summary as { id: string }).id;
    const cf = await call(confirm as Handler, "POST", { id }, { paymentMethod: "pm_card_visa", ...key() });
    expect(cf.status).toBe(200);
    ids[scenario] = id;
    return id;
  }

  it("A — immediate deposit (Destination Charge): 90 zł to the seller, 10 zł platform fee", async () => {
    const id = await start("A", { chargeModel: "destination", captureMethod: "automatic", applicationFeeAmount: 1000 });
    const d = await detailsUntil(id, (x) => !!x.objects.applicationFee && x.funds.sellerNet === 9000);
    evidence.A = d;
    expect(d.summary.status).toBe("succeeded");
    expect(d.summary.booking).toMatchObject({ id: bookingId, scenario: "A" });
    expect(d.funds.sellerNet).toBe(9000);
    expect(d.funds.applicationFeeNet).toBe(1000);
    expect(d.funds.platformNet).toBe(1000 - d.funds.stripeFees);
  }, 120_000);

  it("B — authorization (Destination Charge, manual capture): nothing captured until capture", async () => {
    const id = await start("B", { chargeModel: "destination", captureMethod: "manual", applicationFeeAmount: 1000 });
    const held = await detailsUntil(id, (x) => x.summary.status === "requires_capture");
    evidence.B_before = held;
    expect(held.summary.amount_received).toBe(0);
    expect(held.objects.charge?.amount_captured).toBe(0);
    expect(held.objects.transfers).toEqual([]);
    expect(held.ledger.platform).toEqual([]);
    expect(held.ledger.connected).toEqual([]);

    expect((await call(capture as Handler, "POST", { id }, key())).status).toBe(200);
    const d = await detailsUntil(id, (x) => !!x.objects.applicationFee && x.funds.sellerNet === 9000);
    evidence.B_after = d;
    expect(d.funds.sellerNet).toBe(9000);
    expect(d.funds.applicationFeeNet).toBe(1000);
  }, 120_000);

  it("C — delayed transfer (Separate Charges and Transfers): platform decides when 90 zł moves", async () => {
    const id = await start("C", { chargeModel: "separate", captureMethod: "automatic" });
    const paid = await detailsUntil(id, (x) => x.summary.status === "succeeded" && x.ledger.platform.length >= 1);
    evidence.C_before = paid;
    expect(paid.objects.transfers).toEqual([]);
    expect(paid.funds.sellerNet).toBe(0);
    expect(paid.funds.platformNet).toBe(10000 - paid.funds.stripeFees);

    const t = await call(transfer as Handler, "POST", {}, { paymentIntentId: id, amount: 9000, ...key() });
    expect(t.status).toBe(200);
    const tr = await getStripe().transfers.retrieve(t.body.objectId as string);
    expect(tr.metadata.booking_id).toBe(bookingId);
    const d = await detailsUntil(id, (x) => x.funds.sellerNet === 9000);
    evidence.C_after = d;
    expect(d.funds.sellerNet).toBe(9000);
    expect(d.funds.platformNet).toBe(1000 - d.funds.stripeFees);
  }, 120_000);

  it("lists the booking with all three runs via Stripe Search (may lag)", async () => {
    const t0 = Date.now();
    let found: BookingListItem | undefined;
    while (Date.now() - t0 < 150_000) {
      const r = await call(bookings as Handler, "GET", {}, undefined, `http://localhost:3000/api/lab/bookings?id=${bookingId}`);
      expect(r.status).toBe(200);
      found = (r.body.bookings as BookingListItem[]).find((b) => b.id === bookingId);
      if (found?.runs.length === 3) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    evidence.searchLagMs = Date.now() - t0;
    evidence.booking = found;
    writeFileSync("test-results/sandbox/abc.json", JSON.stringify({ ids, ...evidence }, null, 2));
    expect(found).toMatchObject({ item: "Wiertarka udarowa", start: "2026-10-24", end: "2026-10-27" });
    expect(found!.runs.map((x) => x.scenario).sort()).toEqual(["A", "B", "C"]);
  }, 180_000);
});
