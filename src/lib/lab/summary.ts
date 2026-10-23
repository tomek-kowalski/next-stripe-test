import type Stripe from "stripe";
import { chargeModelOf, sellerAccountOf } from "./rules";

export type AuthorizationSummary = {
  amount_authorized: number | null;
  /** Unix seconds after which an uncaptured authorization is released automatically. */
  capture_before: number | null;
  capture_before_iso: string | null;
  extended_authorization_status: string | null;
  multicapture_status: string | null;
  overcapture_status: string | null;
  brand: string | null;
  last4: string | null;
};

export type ChargeSummary = {
  id: string;
  status: Stripe.Charge.Status;
  captured: boolean;
  amount: number;
  amount_captured: number;
  amount_refunded: number;
  refunded: boolean;
  authorization: AuthorizationSummary | null;
};

export type PaymentIntentSummary = {
  id: string;
  status: Stripe.PaymentIntent.Status;
  amount: number;
  amount_capturable: number;
  amount_received: number;
  currency: string;
  capture_method: Stripe.PaymentIntent.CaptureMethod;
  cancellation_reason: string | null;
  livemode: boolean;
  created_iso: string;
  last_payment_error: { code: string | null; decline_code: string | null; message: string | null } | null;
  /** null when latest_charge was not expanded or no charge exists yet. */
  charge: ChargeSummary | null;
  connect: {
    charge_model: "platform" | "destination" | "separate";
    destination: string | null;
    application_fee_amount: number | null;
    transfer_group: string | null;
  };
  /** Booking this payment belongs to (from metadata), if any. */
  booking: BookingInfo | null;
};

export type BookingInfo = { id: string; scenario: string | null; item: string | null; customer: string | null; start: string | null; end: string | null };

export function bookingOf(metadata: Stripe.Metadata | null | undefined): BookingInfo | null {
  if (!metadata?.booking_id) return null;
  return {
    id: metadata.booking_id,
    scenario: metadata.booking_scenario ?? null,
    item: metadata.booking_item ?? null,
    customer: metadata.booking_customer ?? null,
    start: metadata.booking_start ?? null,
    end: metadata.booking_end ?? null,
  };
}

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

export function summarizeCharge(charge: Stripe.Charge): ChargeSummary {
  const card = charge.payment_method_details?.card;
  return {
    id: charge.id,
    status: charge.status,
    captured: charge.captured,
    amount: charge.amount,
    amount_captured: charge.amount_captured,
    amount_refunded: charge.amount_refunded,
    refunded: charge.refunded,
    authorization: card
      ? {
          amount_authorized: card.amount_authorized ?? null,
          capture_before: card.capture_before ?? null,
          capture_before_iso: card.capture_before ? iso(card.capture_before) : null,
          extended_authorization_status: card.extended_authorization?.status ?? null,
          multicapture_status: card.multicapture?.status ?? null,
          overcapture_status: card.overcapture?.status ?? null,
          brand: card.brand ?? null,
          last4: card.last4 ?? null,
        }
      : null,
  };
}

export function summarizePaymentIntent(pi: Stripe.PaymentIntent): PaymentIntentSummary {
  const charge = pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  return {
    id: pi.id,
    status: pi.status,
    amount: pi.amount,
    amount_capturable: pi.amount_capturable,
    amount_received: pi.amount_received,
    currency: pi.currency,
    capture_method: pi.capture_method,
    cancellation_reason: pi.cancellation_reason ?? null,
    livemode: pi.livemode,
    created_iso: iso(pi.created),
    last_payment_error: pi.last_payment_error
      ? {
          code: pi.last_payment_error.code ?? null,
          decline_code: pi.last_payment_error.decline_code ?? null,
          message: pi.last_payment_error.message ?? null,
        }
      : null,
    charge: charge ? summarizeCharge(charge) : null,
    connect: {
      charge_model: chargeModelOf(pi),
      destination: sellerAccountOf(pi),
      application_fee_amount: pi.application_fee_amount ?? null,
      transfer_group: pi.transfer_group ?? null,
    },
    booking: bookingOf(pi.metadata),
  };
}
