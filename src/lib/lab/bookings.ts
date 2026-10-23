import type Stripe from "stripe";
import { LAB_ACCOUNT_TAG } from "./connect/account";
import { bookingOf, type BookingInfo } from "./summary";

// Bookings have no storage of their own: they are reconstructed from the metadata of
// the lab's PaymentIntents via the Stripe Search API. Stripe documents that search
// results can lag behind writes (typically up to about a minute), so a booking created a
// moment ago may not be listed yet; the dashboard keeps the current booking in memory.

export type BookingRun = {
  scenario: string | null;
  paymentIntentId: string;
  status: string;
  amount: number;
  created_iso: string;
};

export type BookingListItem = Omit<BookingInfo, "scenario"> & { runs: BookingRun[]; lastActivity_iso: string };

export async function listBookings(stripe: Stripe, bookingId?: string): Promise<BookingListItem[]> {
  const query = bookingId
    ? `metadata['lab']:'${LAB_ACCOUNT_TAG.lab}' AND metadata['booking_id']:'${bookingId}'`
    : `metadata['lab']:'${LAB_ACCOUNT_TAG.lab}'`;
  const result = await stripe.paymentIntents.search({ query, limit: 100 });

  const byId = new Map<string, BookingListItem>();
  for (const pi of result.data) {
    const booking = bookingOf(pi.metadata);
    if (!booking) continue;
    const created = new Date(pi.created * 1000).toISOString();
    const entry =
      byId.get(booking.id) ??
      { id: booking.id, item: booking.item, customer: booking.customer, start: booking.start, end: booking.end, runs: [], lastActivity_iso: created };
    entry.runs.push({ scenario: booking.scenario, paymentIntentId: pi.id, status: pi.status, amount: pi.amount, created_iso: created });
    if (created > entry.lastActivity_iso) entry.lastActivity_iso = created;
    byId.set(booking.id, entry);
  }
  return [...byId.values()]
    .map((b) => ({ ...b, runs: b.runs.sort((x, y) => x.created_iso.localeCompare(y.created_iso)) }))
    .sort((a, b) => b.lastActivity_iso.localeCompare(a.lastActivity_iso));
}
