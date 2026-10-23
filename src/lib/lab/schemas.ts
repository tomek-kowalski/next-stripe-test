import { z } from "zod";

// User-facing validation messages are Polish (the dashboard language).
z.config(z.locales.pl());

/** Amounts are always integer minor units (grosze): 5000 = 50.00 PLN. */
export const AmountSchema = z
  .number({ error: "Kwota musi być liczbą całkowitą w groszach." })
  .int({ error: "Kwota musi być liczbą całkowitą w groszach." })
  .min(1, { error: "Kwota musi być większa od zera." })
  .max(1_000_000, { error: "Maksymalna kwota laboratorium to 10 000,00 PLN." });

/** The lab transacts in Polish złoty only; any other currency is rejected. */
export const LAB_CURRENCY = "pln";
export const CurrencySchema = z.literal(LAB_CURRENCY, { error: "Obsługiwana jest wyłącznie waluta PLN." });
export type Currency = z.infer<typeof CurrencySchema>;

/** Only Stripe test PaymentMethods that authorize successfully. */
export const TestPaymentMethodSchema = z.enum(["pm_card_visa", "pm_card_mastercard", "pm_card_visa_debit"]);
export type TestPaymentMethod = z.infer<typeof TestPaymentMethodSchema>;

export const PaymentIntentIdSchema = z.string().regex(/^pi_[A-Za-z0-9]+$/, "Oczekiwano identyfikatora PaymentIntent (pi_…).");
export const TransferIdSchema = z.string().regex(/^tr_[A-Za-z0-9]+$/, "Oczekiwano identyfikatora Transfer (tr_…).");
export const ApplicationFeeIdSchema = z.string().regex(/^fee_[A-Za-z0-9]+$/, "Oczekiwano identyfikatora Application Fee (fee_…).");
export const ConnectedAccountIdSchema = z.string().regex(/^acct_[A-Za-z0-9]+$/, "Oczekiwano identyfikatora konta (acct_…).");

export const IdempotencyKeySchema = z.uuid();

/**
 * platform    — the charge stays on the platform (Phase 1).
 * destination — Destination Charge: transfer_data.destination + application_fee_amount.
 * separate    — Separate Charges and Transfers: platform charge with a transfer_group,
 *               transfers created explicitly later.
 */
export const ChargeModelSchema = z.enum(["platform", "destination", "separate"]);
export type ChargeModel = z.infer<typeof ChargeModelSchema>;

/**
 * Shared booking for scenarios A/B/C. There is no database: the booking lives only as
 * metadata on the Stripe objects of each scenario run (PaymentIntent, Transfer).
 */
export const BookingIdSchema = z.string().regex(/^bk_[a-z0-9]{12}$/, "Oczekiwano identyfikatora rezerwacji (bk_…).");
export const ScenarioLetterSchema = z.enum(["A", "B", "C"]);
export type ScenarioLetter = z.infer<typeof ScenarioLetterSchema>;
export const BookingSchema = z
  .strictObject({
    id: BookingIdSchema,
    scenario: ScenarioLetterSchema,
    item: z.string().trim().min(1, { error: "Podaj przedmiot rezerwacji." }).max(60),
    customer: z.string().trim().min(1, { error: "Podaj klienta." }).max(60),
    start: z.iso.date({ error: "Nieprawidłowa data rozpoczęcia." }),
    end: z.iso.date({ error: "Nieprawidłowa data zakończenia." }),
  })
  .refine((b) => b.end >= b.start, { path: ["end"], message: "Data zakończenia nie może być wcześniejsza niż data rozpoczęcia." });
export type Booking = z.infer<typeof BookingSchema>;

export const CreatePaymentIntentBodySchema = z
  .strictObject({
    booking: BookingSchema.optional(),
    amount: AmountSchema,
    currency: CurrencySchema.default(LAB_CURRENCY),
    scenario: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
    chargeModel: ChargeModelSchema.default("platform"),
    captureMethod: z.enum(["manual", "automatic"]).default("manual"),
    accountId: ConnectedAccountIdSchema.optional(),
    applicationFeeAmount: z.number().int().min(0).optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .superRefine((body, ctx) => {
    if (body.chargeModel !== "platform" && !body.accountId) {
      ctx.addIssue({ code: "custom", path: ["accountId"], message: "Model z kontem połączonym wymaga wskazania konta sprzedawcy." });
    }
    if (body.chargeModel === "platform" && body.accountId) {
      ctx.addIssue({ code: "custom", path: ["accountId"], message: "Płatność platformowa nie może wskazywać konta sprzedawcy." });
    }
    if (body.applicationFeeAmount !== undefined && body.chargeModel !== "destination") {
      ctx.addIssue({ code: "custom", path: ["applicationFeeAmount"], message: "Prowizję application_fee_amount ustawia się tylko dla Destination Charge." });
    }
    if (body.applicationFeeAmount !== undefined && body.applicationFeeAmount >= body.amount) {
      ctx.addIssue({ code: "custom", path: ["applicationFeeAmount"], message: "Prowizja platformy musi być mniejsza od kwoty płatności." });
    }
  });
export type CreatePaymentIntentBody = z.infer<typeof CreatePaymentIntentBodySchema>;
/** What callers send: defaults (currency PLN, platform model, manual capture) may be omitted. */
export type CreatePaymentIntentInput = z.input<typeof CreatePaymentIntentBodySchema>;

export const ConfirmPaymentIntentBodySchema = z.strictObject({
  paymentMethod: TestPaymentMethodSchema,
  idempotencyKey: IdempotencyKeySchema.optional(),
});
export type ConfirmPaymentIntentBody = z.infer<typeof ConfirmPaymentIntentBodySchema>;

export const CapturePaymentIntentBodySchema = z.strictObject({
  /** Omit for a full capture of amount_capturable. */
  amountToCapture: AmountSchema.optional(),
  /** Destination Charges only: re-sets the platform fee for this capture. */
  applicationFeeAmount: z.number().int().min(0).optional(),
  idempotencyKey: IdempotencyKeySchema.optional(),
});
export type CapturePaymentIntentBody = z.infer<typeof CapturePaymentIntentBodySchema>;

export const CancelPaymentIntentBodySchema = z.strictObject({
  cancellationReason: z.enum(["requested_by_customer", "abandoned", "duplicate", "fraudulent"]).optional(),
  idempotencyKey: IdempotencyKeySchema.optional(),
});
export type CancelPaymentIntentBody = z.infer<typeof CancelPaymentIntentBodySchema>;

export const RefundBodySchema = z.strictObject({
  /** Omit for a refund of everything still refundable. */
  amount: AmountSchema.optional(),
  /** Destination Charges only. */
  reverseTransfer: z.boolean().default(false),
  refundApplicationFee: z.boolean().default(false),
  idempotencyKey: IdempotencyKeySchema,
});
export type RefundBody = z.infer<typeof RefundBodySchema>;

export const TransferBodySchema = z.strictObject({
  paymentIntentId: PaymentIntentIdSchema,
  amount: AmountSchema,
  idempotencyKey: IdempotencyKeySchema,
});
export type TransferBody = z.infer<typeof TransferBodySchema>;

export const ReversalBodySchema = z.strictObject({
  /** Omit to reverse everything not yet reversed. */
  amount: AmountSchema.optional(),
  idempotencyKey: IdempotencyKeySchema,
});
export type ReversalBody = z.infer<typeof ReversalBodySchema>;

export const ApplicationFeeRefundBodySchema = z.strictObject({
  amount: AmountSchema.optional(),
  idempotencyKey: IdempotencyKeySchema,
});
export type ApplicationFeeRefundBody = z.infer<typeof ApplicationFeeRefundBodySchema>;
