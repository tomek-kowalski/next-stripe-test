// Client-side helpers for the dashboard. Only types are imported from server modules.
import type { AccountReadiness, AccountStatus } from "@/lib/lab/connect/account";
import type { PaymentDetails } from "@/lib/lab/details";

export type { PaymentDetails };

export type AccountRow = AccountStatus & { created_iso: string | null; readiness: AccountReadiness | null };
export type AccountsResponse = { ok: true; fetchedAt: string; accounts: AccountRow[] };
export type BalanceResponse = {
  ok: true;
  fetchedAt: string;
  seller: { accountId: string; pending: number; available: number };
  platform: { pending: number; available: number };
};

export type ApiError = {
  ok: false;
  kind?: string;
  message?: string;
  requestId?: string | null;
  issues?: { path: string; message: string }[] | null;
  stripe?: { code: string | null } | null;
};

export type ApiResult<T> = { httpStatus: number; ok: true; body: T } | { httpStatus: number; ok: false; body: ApiError };

export async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const json = (await res.json()) as (T & { ok?: boolean }) | ApiError;
    if (res.ok && (json as { ok?: boolean }).ok !== false) return { httpStatus: res.status, ok: true, body: json as T };
    return { httpStatus: res.status, ok: false, body: json as ApiError };
  } catch (e) {
    return { httpStatus: 0, ok: false, body: { ok: false, kind: "network", message: `Błąd sieci: ${(e as Error).message}` } };
  }
}

export const newKey = () => crypto.randomUUID();

export const pln = (grosze: number | null | undefined) =>
  grosze === null || grosze === undefined ? "—" : (grosze / 100).toLocaleString("pl-PL", { style: "currency", currency: "PLN" });

export const dateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "medium" }) : "—";

export function errorText(r: { httpStatus: number; body: ApiError }) {
  const issues = r.body.issues?.map((i) => `${i.path || "dane"}: ${i.message}`).join("; ");
  return `${r.body.message ?? "Nieznany błąd"}${issues ? ` (${issues})` : ""} [HTTP ${r.httpStatus}${r.body.kind ? `, ${r.body.kind}` : ""}]`;
}

/** Polish labels for raw Stripe statuses (the raw value is always shown next to it). */
export const STATUS_PL: Record<string, string> = {
  requires_payment_method: "oczekuje na metodę płatności",
  requires_confirmation: "oczekuje na potwierdzenie",
  requires_action: "wymaga działania klienta",
  requires_capture: "autoryzowana — oczekuje na przechwycenie",
  processing: "w trakcie przetwarzania",
  succeeded: "przechwycona (obciążona)",
  canceled: "anulowana — blokada zwolniona",
  pending: "oczekujące (nierozliczone)",
  available: "dostępne",
  failed: "nieudane",
};

export const EVENT_PL: Record<string, string> = {
  "payment_intent.created": "Utworzono PaymentIntent",
  "payment_intent.amount_capturable_updated": "Autoryzacja: środki zablokowane na karcie",
  "payment_intent.succeeded": "Płatność przechwycona",
  "payment_intent.canceled": "PaymentIntent anulowany",
  "payment_intent.payment_failed": "Płatność nieudana",
  "charge.succeeded": "Obciążenie (Charge) zakończone sukcesem",
  "charge.captured": "Obciążenie przechwycone",
  "charge.updated": "Obciążenie zaktualizowane",
  "charge.refunded": "Zwrot zarejestrowany na obciążeniu",
  "charge.refund.updated": "Zwrot zaktualizowany",
  "refund.created": "Utworzono zwrot",
  "refund.updated": "Zwrot zaktualizowany",
  "transfer.created": "Utworzono przelew do sprzedawcy",
  "payment.created": "Środki zaksięgowane u sprzedawcy (destination payment)",
  "transfer.updated": "Przelew zaktualizowany",
  "transfer.reversed": "Przelew cofnięty (w całości)",
  "application_fee.created": "Pobrano prowizję platformy (application fee)",
  "application_fee.refunded": "Zwrócono prowizję platformy",
  "application_fee.refund.updated": "Zwrot prowizji zaktualizowany",
};

export const MODEL_PL = {
  platform: "Płatność platformowa",
  destination: "Destination Charge",
  separate: "Separate Charges and Transfers",
} as const;
