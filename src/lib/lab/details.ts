import type Stripe from "stripe";
import { ledgerBySources, type LedgerEntry, type LedgerTotals } from "./connect/ledger";
import { gatherObjects, type ScenarioObjects } from "./connect/scenarios";
import { requireLabPaymentIntent, sellerAccountOf } from "./rules";
import { summarizePaymentIntent, type PaymentIntentSummary } from "./summary";

// Read-only view of one lab PaymentIntent, assembled from Stripe on demand (no database).

export type TimelineEvent = {
  eventId: string;
  type: string;
  /** Stripe's event timestamp (when Stripe recorded the change). */
  at_iso: string;
  account: "platform" | "connected";
  objectId: string;
  /** The API request that caused the event; null for changes Stripe made on its own. */
  requestId: string | null;
  idempotencyKey: string | null;
};

export type Funds = {
  stripeFees: number;
  /** Application fee kept by the platform, net of application fee refunds. */
  applicationFeeNet: number;
  /** Net amount moved from the platform to the seller (transfers minus reversals). */
  transferredToSeller: number;
  platformNet: number;
  platformPending: number;
  platformAvailable: number;
  sellerNet: number;
  sellerPending: number;
  sellerAvailable: number;
  currencyConversion: boolean;
};

export type PaymentDetails = {
  ok: true;
  summary: PaymentIntentSummary;
  sellerAccountId: string | null;
  objects: ScenarioObjects;
  ledger: { platform: LedgerEntry[]; connected: LedgerEntry[]; platformTotals: LedgerTotals; connectedTotals: LedgerTotals };
  funds: Funds;
  timeline: TimelineEvent[];
  /** Stripe Events are kept for 30 days and written asynchronously; the timeline can lag or be incomplete. */
  timelineScanned: { platform: number; connected: number; truncated: boolean };
  /** A future (or passed) deadline, never shown as an event. */
  authorizationDeadline: { capture_before_iso: string; passed: boolean } | null;
  fetchedAt: string;
};

const MAX_EVENTS_SCANNED = 1000;

async function eventsFor(stripe: Stripe, since: number, related: Set<string>, account: "platform" | "connected", options?: Stripe.RequestOptions) {
  const out: TimelineEvent[] = [];
  let scanned = 0;
  for await (const event of stripe.events.list({ created: { gte: since }, limit: 100 }, options)) {
    if (++scanned > MAX_EVENTS_SCANNED) return { out, scanned, truncated: true };
    const obj = event.data.object as { id?: string; payment_intent?: string | null };
    const objectId = obj.id ?? "";
    if (!related.has(objectId) && !(obj.payment_intent && related.has(obj.payment_intent))) continue;
    out.push({
      eventId: event.id,
      type: event.type,
      at_iso: new Date(event.created * 1000).toISOString(),
      account,
      objectId,
      requestId: event.request?.id ?? null,
      idempotencyKey: event.request?.idempotency_key ?? null,
    });
  }
  return { out, scanned, truncated: false };
}

export async function getPaymentDetails(stripe: Stripe, paymentIntentId: string): Promise<PaymentDetails> {
  const pi = await requireLabPaymentIntent(stripe, paymentIntentId, ["latest_charge"]);
  const summary = summarizePaymentIntent(pi);
  const seller = sellerAccountOf(pi);
  const { objects } = await gatherObjects(stripe, pi.id, { waitForTransfer: false });

  // Seller-side objects: the destination payment (py_) of each transfer and its refunds (pyr_).
  const destinationPayments = objects.transfers.map((t) => t.destination_payment).filter((x): x is string => !!x);
  const paymentRefunds = seller
    ? (
        await Promise.all(
          destinationPayments.map((py) => stripe.charges.retrieve(py, { expand: ["refunds"] }, { stripeAccount: seller })),
        )
      ).flatMap((c) => c.refunds?.data.map((r) => r.id) ?? [])
    : [];

  // Observed: a transfer_refund balance transaction reports source = tr_…, but filtering by
  // source=tr_… does not return it; it is only found by the reversal ID (trr_…). The same
  // lookup is used for application fee refunds (fr_…).
  const platformSources = [
    objects.charge?.id,
    ...objects.transfers.map((t) => t.id),
    ...objects.transferReversals.map((r) => r.id),
    ...objects.refunds.map((r) => r.id),
    objects.applicationFee?.id,
    ...(objects.applicationFee?.refundIds ?? []),
  ].filter((x): x is string => !!x);
  const ledger = await ledgerBySources(stripe, {
    platformSources,
    connectedSources: [...destinationPayments, ...paymentRefunds],
    connectedAccountId: seller,
    since: pi.created - 1,
  });

  const sumNet = (entries: LedgerEntry[], types: string[]) => entries.filter((e) => types.includes(e.type)).reduce((n, e) => n + e.net, 0);
  const funds: Funds = {
    stripeFees: ledger.platformTotals.stripeFees,
    applicationFeeNet: sumNet(ledger.platform, ["application_fee", "application_fee_refund"]),
    transferredToSeller: -sumNet(ledger.platform, ["transfer", "transfer_refund"]),
    platformNet: ledger.platformTotals.net,
    platformPending: ledger.platformTotals.pendingNet,
    platformAvailable: ledger.platformTotals.availableNet,
    sellerNet: ledger.connectedTotals.net,
    sellerPending: ledger.connectedTotals.pendingNet,
    sellerAvailable: ledger.connectedTotals.availableNet,
    currencyConversion: ledger.platformTotals.currencyConversion || ledger.connectedTotals.currencyConversion,
  };

  const platformRelated = new Set(
    [
      pi.id,
      objects.charge?.id,
      ...objects.transfers.map((t) => t.id),
      ...objects.transferReversals.map((r) => r.id),
      ...objects.refunds.map((r) => r.id),
      objects.applicationFee?.id,
      ...(objects.applicationFee?.refundIds ?? []),
    ].filter((x): x is string => !!x),
  );
  const since = pi.created - 1;
  const [platformEvents, connectedEvents] = await Promise.all([
    eventsFor(stripe, since, platformRelated, "platform"),
    seller && destinationPayments.length
      ? eventsFor(stripe, since, new Set([...destinationPayments, ...paymentRefunds]), "connected", { stripeAccount: seller })
      : Promise.resolve({ out: [], scanned: 0, truncated: false }),
  ]);
  const timeline = [...platformEvents.out, ...connectedEvents.out].sort((a, b) => a.at_iso.localeCompare(b.at_iso) || a.eventId.localeCompare(b.eventId));

  const captureBefore = summary.charge?.authorization?.capture_before ?? null;
  return {
    ok: true,
    summary,
    sellerAccountId: seller,
    objects,
    ledger,
    funds,
    timeline,
    timelineScanned: {
      platform: platformEvents.scanned,
      connected: connectedEvents.scanned,
      truncated: platformEvents.truncated || connectedEvents.truncated,
    },
    authorizationDeadline:
      captureBefore && pi.status === "requires_capture"
        ? { capture_before_iso: new Date(captureBefore * 1000).toISOString(), passed: captureBefore * 1000 < Date.now() }
        : null,
    fetchedAt: new Date().toISOString(),
  };
}

