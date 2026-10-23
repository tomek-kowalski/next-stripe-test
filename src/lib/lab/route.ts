import type Stripe from "stripe";
import type { ZodType } from "zod";
import { getStripe } from "@/lib/stripe/client";
import { checkLocalRequest } from "./guard";
import { toFailure } from "./operations";
import { PaymentIntentIdSchema } from "./schemas";
import type { OperationFailure, OperationName, OperationResult } from "./types";

const NO_STORE = { "cache-control": "no-store" };

export function json(result: OperationResult): Response {
  return Response.json(result, { status: result.httpStatus, headers: NO_STORE });
}

type Run<T> = (stripe: Stripe, input: T, paymentIntentId: string | null) => Promise<OperationResult>;

/**
 * Shared pipeline for lab API routes: local-only guard → Zod validation of the
 * route param and body → Stripe call → uniform JSON envelope.
 */
export async function handleLabOperation<T>(
  request: Request,
  operation: OperationName,
  options: { body: ZodType<T> | null; paymentIntentId?: string },
  run: Run<T>,
): Promise<Response> {
  const rejection = checkLocalRequest(request);
  if (rejection) {
    const failure: OperationFailure = {
      ...toFailure(operation, null, new Error(rejection.message)),
      httpStatus: rejection.status,
      kind: "forbidden",
    };
    return json(failure);
  }

  let input: T;
  let paymentIntentId: string | null = null;
  try {
    if (options.paymentIntentId !== undefined) {
      paymentIntentId = PaymentIntentIdSchema.parse(options.paymentIntentId);
    }
    if (options.body) {
      let parsed: unknown;
      try {
        parsed = await request.json();
      } catch {
        return json({ ...toFailure(operation, null, new Error("Treść żądania nie jest poprawnym JSON.")), httpStatus: 400, kind: "validation" });
      }
      input = options.body.parse(parsed);
    } else {
      input = undefined as T;
    }
  } catch (error) {
    return json(toFailure(operation, null, error));
  }

  let stripe: Stripe;
  try {
    stripe = getStripe();
  } catch (error) {
    return json(toFailure(operation, null, error));
  }

  return json(await run(stripe, input, paymentIntentId));
}
