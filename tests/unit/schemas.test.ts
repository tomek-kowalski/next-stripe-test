import { describe, expect, it } from "vitest";
import { CapturePaymentIntentBodySchema, CreatePaymentIntentBodySchema, PaymentIntentIdSchema } from "@/lib/lab/schemas";
import { validateContext } from "@/lib/lab/scenarios";

describe("schemas", () => {
  it("accepts integer minor units only", () => {
    expect(CreatePaymentIntentBodySchema.safeParse({ amount: 5000, currency: "pln" }).success).toBe(true);
    expect(CreatePaymentIntentBodySchema.safeParse({ amount: 50.5, currency: "pln" }).success).toBe(false);
    expect(CreatePaymentIntentBodySchema.safeParse({ amount: 0, currency: "pln" }).success).toBe(false);
    expect(CreatePaymentIntentBodySchema.safeParse({ amount: "5000", currency: "pln" }).success).toBe(false);
  });

  it("accepts only PLN and defaults to it", () => {
    expect(CreatePaymentIntentBodySchema.parse({ amount: 5000 }).currency).toBe("pln");
    expect(CreatePaymentIntentBodySchema.safeParse({ amount: 5000, currency: "eur" }).success).toBe(false);
  });

  it("rejects unknown fields so callers cannot inject Stripe params", () => {
    expect(CreatePaymentIntentBodySchema.safeParse({ amount: 5000, currency: "pln", capture_method: "automatic" }).success).toBe(false);
    expect(CapturePaymentIntentBodySchema.safeParse({ application_fee_amount: 1 }).success).toBe(false);
  });

  it("validates PaymentIntent IDs", () => {
    expect(PaymentIntentIdSchema.safeParse("pi_3Abc123").success).toBe(true);
    expect(PaymentIntentIdSchema.safeParse("ch_123").success).toBe(false);
    expect(PaymentIntentIdSchema.safeParse("pi_1/../../v1/charges").success).toBe(false);
  });

  it("requires partial amount below the authorized amount", () => {
    const base = { paymentMethod: "pm_card_visa" as const };
    expect(validateContext({ ...base, amount: 5000, partialAmount: 2000 })).toBeNull();
    expect(validateContext({ ...base, amount: 5000, partialAmount: 5000 })).not.toBeNull();
  });
});
