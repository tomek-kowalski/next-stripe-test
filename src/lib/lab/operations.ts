import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { ZodError } from "zod";
import { LabConfigError } from "@/lib/stripe/client";
import type {
  CancelPaymentIntentBody,
  CapturePaymentIntentBody,
  ConfirmPaymentIntentBody,
  CreatePaymentIntentBody,
} from "./schemas";
import { isPublicMode, PUBLIC_MAX_AMOUNT } from "./guard";
import {
  assertCancelable,
  assertCapturable,
  assertConfirmable,
  LabRuleError,
  requireLabPaymentIntent,
  requireReadyLabAccount,
  sellerAccountOf,
} from "./rules";
import { summarizePaymentIntent } from "./summary";
import type { OperationFailure, OperationName, OperationResult } from "./types";

// Every response that returns a PaymentIntent expands the latest charge, because
// authorization details (capture_before, amount_authorized, extended authorization)
// live on charge.payment_method_details.card, not on the PaymentIntent.
const EXPAND = ["latest_charge"];

async function execute(
  operation: OperationName,
  idempotencyKey: string | null,
  call: () => Promise<Stripe.Response<Stripe.PaymentIntent>>,
): Promise<OperationResult> {
  try {
    const pi = await call();
    return {
      ok: true,
      operation,
      httpStatus: 200,
      requestId: pi.lastResponse?.requestId ?? null,
      idempotencyKey,
      summary: summarizePaymentIntent(pi),
      raw: pi,
    };
  } catch (error) {
    return toFailure(operation, idempotencyKey, error);
  }
}

export function toFailure(operation: OperationName, idempotencyKey: string | null, error: unknown): OperationFailure {
  const base = { ok: false as const, operation, idempotencyKey, requestId: null, stripe: null, issues: null, summary: null, raw: null };

  if (error instanceof ZodError) {
    return {
      ...base,
      httpStatus: 400,
      kind: "validation",
      message: "Nieprawidłowe dane żądania.",
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    };
  }
  if (error instanceof LabRuleError) {
    return { ...base, httpStatus: error.status, kind: "rule", message: error.message };
  }
  if (error instanceof Stripe.errors.StripeError) {
    const pi = error.payment_intent as Stripe.PaymentIntent | undefined;
    return {
      ...base,
      httpStatus: error.statusCode ?? 502,
      kind: "stripe",
      // Stripe's own message is kept verbatim (English) for traceability.
      message: `Stripe odrzucił operację: ${error.message}`,
      requestId: error.requestId ?? null,
      stripe: {
        type: error.type,
        code: error.code ?? null,
        decline_code: error.decline_code ?? null,
        param: error.param ?? null,
        doc_url: error.doc_url ?? null,
      },
      summary: pi ? summarizePaymentIntent(pi) : null,
      raw: error.raw ?? null,
    };
  }
  if (error instanceof LabConfigError) {
    return { ...base, httpStatus: 500, kind: "config", message: error.message };
  }
  return {
    ...base,
    httpStatus: 500,
    kind: "internal",
    message: error instanceof Error ? error.message : "Nieznany błąd",
  };
}

export function createPaymentIntent(stripe: Stripe, body: CreatePaymentIntentBody): Promise<OperationResult> {
  const idempotencyKey = body.idempotencyKey ?? randomUUID();
  return execute("create", idempotencyKey, async () => {
    if (isPublicMode() && body.amount > PUBLIC_MAX_AMOUNT) {
      throw new LabRuleError(`W trybie testów publicznych maksymalna kwota płatności to ${PUBLIC_MAX_AMOUNT / 100} zł.`, 422);
    }
    // Money may only ever be routed to the tagged, ready lab account.
    if (body.accountId) await requireReadyLabAccount(stripe, body.accountId);
    const scenario = body.scenario ?? "manual";
    return stripe.paymentIntents.create(
      {
        amount: body.amount,
        currency: body.currency,
        capture_method: body.captureMethod,
        // Card only, so confirmation never needs a return_url for redirect-based methods.
        // (API 2026-09-30.endive removed `payment_method_types` on create in favour of this.)
        allowed_payment_method_types: ["card"],
        description: `stripe-connect-lab (${body.chargeModel}, ${scenario})`,
        ...(body.chargeModel === "destination" && {
          transfer_data: { destination: body.accountId! },
          ...(body.applicationFeeAmount !== undefined && { application_fee_amount: body.applicationFeeAmount }),
        }),
        ...(body.chargeModel === "separate" && { transfer_group: `lab-${randomUUID()}` }),
        metadata: {
          lab: "stripe-connect-lab",
          charge_model: body.chargeModel,
          scenario,
          ...(body.accountId && { lab_destination: body.accountId }),
          ...(body.booking && {
            booking_id: body.booking.id,
            booking_scenario: body.booking.scenario,
            booking_item: body.booking.item,
            booking_customer: body.booking.customer,
            booking_start: body.booking.start,
            booking_end: body.booking.end,
          }),
        },
        expand: EXPAND,
      },
      { idempotencyKey },
    );
  });
}

export function confirmPaymentIntent(stripe: Stripe, id: string, body: ConfirmPaymentIntentBody): Promise<OperationResult> {
  const idempotencyKey = body.idempotencyKey ?? randomUUID();
  return execute("confirm", idempotencyKey, async () => {
    const pi = await requireLabPaymentIntent(stripe, id);
    assertConfirmable(pi);
    const seller = sellerAccountOf(pi);
    if (seller) await requireReadyLabAccount(stripe, seller);
    return stripe.paymentIntents.confirm(id, { payment_method: body.paymentMethod, expand: EXPAND }, { idempotencyKey });
  });
}

export function retrievePaymentIntent(stripe: Stripe, id: string): Promise<OperationResult> {
  return execute("retrieve", null, () => requireLabPaymentIntent(stripe, id, EXPAND));
}

export function capturePaymentIntent(stripe: Stripe, id: string, body: CapturePaymentIntentBody): Promise<OperationResult> {
  const idempotencyKey = body.idempotencyKey ?? randomUUID();
  return execute("capture", idempotencyKey, async () => {
    const pi = await requireLabPaymentIntent(stripe, id);
    assertCapturable(pi, body.amountToCapture, body.applicationFeeAmount);
    const seller = sellerAccountOf(pi);
    if (seller) await requireReadyLabAccount(stripe, seller);
    return stripe.paymentIntents.capture(
      id,
      {
        ...(body.amountToCapture !== undefined && { amount_to_capture: body.amountToCapture }),
        ...(body.applicationFeeAmount !== undefined && { application_fee_amount: body.applicationFeeAmount }),
        expand: EXPAND,
      },
      { idempotencyKey },
    );
  });
}

export function cancelPaymentIntent(stripe: Stripe, id: string, body: CancelPaymentIntentBody): Promise<OperationResult> {
  const idempotencyKey = body.idempotencyKey ?? randomUUID();
  return execute("cancel", idempotencyKey, async () => {
    assertCancelable(await requireLabPaymentIntent(stripe, id));
    return stripe.paymentIntents.cancel(
      id,
      { ...(body.cancellationReason && { cancellation_reason: body.cancellationReason }), expand: EXPAND },
      { idempotencyKey },
    );
  });
}
