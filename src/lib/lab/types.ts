import type { PaymentIntentSummary } from "./summary";

// Client-safe types shared by the API routes, the dashboard and the tests.

export type OperationName = "create" | "confirm" | "retrieve" | "capture" | "cancel";

export type OperationSuccess = {
  ok: true;
  operation: OperationName;
  httpStatus: number;
  requestId: string | null;
  idempotencyKey: string | null;
  summary: PaymentIntentSummary;
  /** The Stripe API response body, unmodified. */
  raw: unknown;
};

export type FailureKind = "validation" | "rule" | "stripe" | "config" | "forbidden" | "internal";

export type OperationFailure = {
  ok: false;
  operation: OperationName;
  httpStatus: number;
  kind: FailureKind;
  message: string;
  requestId: string | null;
  idempotencyKey: string | null;
  stripe: {
    type: string;
    code: string | null;
    decline_code: string | null;
    param: string | null;
    doc_url: string | null;
  } | null;
  issues: { path: string; message: string }[] | null;
  /** Present when Stripe returned the PaymentIntent together with the error. */
  summary: PaymentIntentSummary | null;
  /** The Stripe error body, unmodified, when the error came from Stripe. */
  raw: unknown;
};

export type OperationResult = OperationSuccess | OperationFailure;

export type LabConfig =
  | {
      ok: true;
      mode: "test";
      apiVersion: string;
      sdkVersion: string;
      account: { id: string; country: string | null; default_currency: string | null; display_name: string | null } | null;
      accountError: string | null;
    }
  | { ok: false; message: string; apiVersion: string; sdkVersion: string };
