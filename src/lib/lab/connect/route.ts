import Stripe from "stripe";
import { ZodError, type ZodType } from "zod";
import { getStripe, LabConfigError } from "@/lib/stripe/client";
import { checkLocalRequest } from "../guard";
import { LabRuleError } from "../rules";
import { NotALabAccountError } from "./account";

const NO_STORE = { "cache-control": "no-store" };

export type ConnectErrorBody = {
  ok: false;
  kind: "validation" | "rule" | "stripe" | "config" | "forbidden" | "internal";
  message: string;
  requestId: string | null;
  stripe: { type: string; code: string | null; decline_code: string | null; param: string | null; doc_url: string | null } | null;
  issues: { path: string; message: string }[] | null;
  raw: unknown;
};

export function describeError(error: unknown): { status: number; body: ConnectErrorBody } {
  const base = { ok: false as const, requestId: null, stripe: null, issues: null, raw: null };
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        ...base,
        kind: "validation",
        message: "Nieprawidłowe dane żądania.",
        issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    };
  }
  if (error instanceof LabRuleError) return { status: error.status, body: { ...base, kind: "rule", message: error.message } };
  if (error instanceof Stripe.errors.StripeError) {
    return {
      status: error.statusCode ?? 502,
      body: {
        ...base,
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
        raw: error.raw ?? null,
      },
    };
  }
  if (error instanceof NotALabAccountError) return { status: 403, body: { ...base, kind: "forbidden", message: error.message } };
  if (error instanceof LabConfigError) return { status: 500, body: { ...base, kind: "config", message: error.message } };
  return { status: 500, body: { ...base, kind: "internal", message: error instanceof Error ? error.message : "Nieznany błąd" } };
}

/** Guard → parse JSON body with Zod (when given) → run → JSON response. */
export async function handleConnect<T>(
  request: Request,
  schema: ZodType<T> | null,
  run: (stripe: Stripe, input: T, origin: string) => Promise<unknown>,
): Promise<Response> {
  const rejection = checkLocalRequest(request);
  if (rejection) return Response.json({ ok: false, kind: "forbidden", message: rejection.message }, { status: rejection.status, headers: NO_STORE });

  try {
    let input = undefined as T;
    if (schema) {
      let parsed: unknown;
      try {
        parsed = await request.json();
      } catch {
        return Response.json({ ok: false, kind: "validation", message: "Treść żądania nie jest poprawnym JSON." }, { status: 400, headers: NO_STORE });
      }
      input = schema.parse(parsed);
    }
    const origin = `http://${request.headers.get("host")}`;
    const result = await run(getStripe(), input, origin);
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = describeError(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
