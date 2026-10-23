"use client";

import type { ReactNode } from "react";
import type { PaymentDetails } from "./api";
import { dateTime, EVENT_PL, MODEL_PL, STATUS_PL } from "./api";
import type { HistoryEntry } from "./history-panel";
import { MoneyFlow } from "./money-flow";
import { moneyStory } from "./money";
import { PaymentDetailsPanel } from "./payment-details-panel";
import { TimelinePanel } from "./timeline-panel";

/** "What you are about to do" block shown before a scenario's first action. */
export function Explain({ action, customer, seller, platform }: { action: string; customer: string; seller: string; platform: string }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {[
        ["Co zrobisz", action],
        ["Pieniądze klienta", customer],
        ["Pieniądze sprzedawcy", seller],
        ["Platforma zarabia / płaci", platform],
      ].map(([title, text]) => (
        <div key={title} className="rounded border border-zinc-300 p-2 dark:border-zinc-700">
          <div className="text-xs font-bold uppercase text-zinc-500">{title}</div>
          <div>{text}</div>
        </div>
      ))}
    </div>
  );
}

export type Step = { title: string; text: string; done: boolean };

/** Guided sequence; completion is derived from the real Stripe state, never from button clicks. */
export function Steps({ steps }: { steps: Step[] }) {
  const current = steps.findIndex((s) => !s.done);
  return (
    <ol className="space-y-1" data-testid="steps">
      {steps.map((s, i) => (
        <li key={s.title} className={`flex gap-2 rounded p-1 ${i === current ? "bg-amber-50 dark:bg-amber-950" : ""}`}>
          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${s.done ? "border-green-600 bg-green-600 text-white" : i === current ? "border-amber-500" : "border-zinc-400 text-zinc-400"}`}>
            {s.done ? "✓" : i + 1}
          </span>
          <span>
            <b className={s.done || i === current ? "" : "text-zinc-500"}>{s.title}</b>
            <span className="block text-xs text-zinc-500">{s.text}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export type NextAction = { label: string; onClick: () => void; disabled?: string | null };

const OPERATION_PL: Record<string, string> = {
  create: "przygotował płatność (PaymentIntent)",
  confirm: "autoryzował kartę klienta",
  capture: "pobrał środki z blokady",
  cancel: "anulował autoryzację i zwolnił blokadę",
  refund: "wykonał zwrot",
  transfer: "przelał środki do sprzedawcy",
  transfer_reversal: "cofnął przelew",
  application_fee_refund: "zwrócił prowizję sprzedawcy",
};

function operationOf(entry: HistoryEntry): string | null {
  const raw = entry.raw as { object?: string } | null;
  if (entry.operation && OPERATION_PL[entry.operation]) return OPERATION_PL[entry.operation];
  if (raw?.object === "refund") return OPERATION_PL.refund;
  if (raw?.object === "transfer") return OPERATION_PL.transfer;
  if (raw?.object === "transfer_reversal") return OPERATION_PL.transfer_reversal;
  if (raw?.object === "fee_refund") return OPERATION_PL.application_fee_refund;
  return null;
}

/** Shown after each operation: outcome, money story, status, flow, next actions, timeline, technical details. */
export function ResultCard({
  details,
  loading,
  lastEntry,
  next,
}: {
  details: PaymentDetails | null;
  loading: boolean;
  lastEntry: HistoryEntry | null;
  next: NextAction[];
}) {
  return (
    <section className="panel space-y-3" data-testid="result-card">
      <h2 className="font-bold">Wynik</h2>

      {lastEntry && (
        <div className={`rounded border p-2 ${lastEntry.ok ? "border-green-600" : "border-red-600"}`} data-testid="last-operation">
          <b className={lastEntry.ok ? "text-green-700 dark:text-green-400" : "text-red-600"}>{lastEntry.ok ? "✓ Udało się" : "✗ Nie udało się"}</b>
          {": "}
          {lastEntry.label}
          {lastEntry.ok && operationOf(lastEntry) && <div className="text-xs">Co wykonał Stripe (Sandbox): {operationOf(lastEntry)}.</div>}
          {!lastEntry.ok && <div className="text-xs">{lastEntry.message}</div>}
          <details className="text-xs text-zinc-500">
            <summary>szczegóły techniczne</summary>
            HTTP {lastEntry.httpStatus} · request ID {lastEntry.requestId ?? "—"} · obiekt {lastEntry.objectId ?? "—"} · klucz idempotencji {lastEntry.idempotencyKey ?? "—"}
          </details>
        </div>
      )}

      {!details ? (
        <p className="text-zinc-500">{loading ? "Wczytywanie danych ze Stripe…" : "Brak płatności — rozpocznij scenariusz powyżej."}</p>
      ) : (
        <>
          <div>
            <div>
              <b>Status:</b> {STATUS_PL[details.summary.status] ?? details.summary.status} <code className="text-xs">({details.summary.status})</code> · {MODEL_PL[details.summary.connect.charge_model]}
              {loading && <span className="text-xs text-zinc-500"> · odświeżanie danych ze Stripe…</span>}
            </div>
            <ul className="ml-5 mt-1 list-disc" data-testid="money-story">
              {moneyStory(details).map((line) => <li key={line}>{line}</li>)}
            </ul>
            <p className="text-xs text-zinc-500">Dane z rzeczywistych obiektów Stripe Sandbox (stan z {dateTime(details.fetchedAt)}). Część danych Stripe dopisuje z kilkusekundowym opóźnieniem — odświeżamy automatycznie.</p>
          </div>

          <MoneyFlow details={details} />

          {next.length > 0 && (
            <div>
              <b>Co dalej?</b>
              <div className="mt-1 flex flex-wrap gap-2">
                {next.map((a) => (
                  <span key={a.label}>
                    <button className="btn" disabled={!!a.disabled} onClick={a.onClick}>{a.label}</button>
                    {a.disabled && <span className="ml-1 text-xs text-zinc-500">({a.disabled})</span>}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div>
            <b>Przebieg w czasie</b>
            {details.timeline.length === 0 ? (
              <p className="text-zinc-500">Stripe jeszcze nie zapisał zdarzeń dla tej płatności.</p>
            ) : (
              <ol className="ml-5 list-decimal text-sm">
                {details.timeline.map((e) => (
                  <li key={e.eventId}>{new Date(e.at_iso).toLocaleTimeString("pl-PL")} — {EVENT_PL[e.type] ?? e.type}{e.account === "connected" ? " (konto sprzedawcy)" : ""}</li>
                ))}
              </ol>
            )}
            {details.authorizationDeadline && (
              <p className="text-amber-700 dark:text-amber-400">⏳ Termin (przyszły, nie zdarzenie): blokada wygasa {dateTime(details.authorizationDeadline.capture_before_iso)}.</p>
            )}
          </div>

          <details>
            <summary className="cursor-pointer font-bold">Szczegóły techniczne Stripe (dla zaawansowanych)</summary>
            <div className="mt-2 space-y-3">
              <PaymentDetailsPanel details={details} loading={loading} />
              <TimelinePanel details={details} />
            </div>
          </details>
        </>
      )}
    </section>
  );
}

export function ScenarioIntro({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel space-y-3">
      <h2 className="text-base font-bold">{title}</h2>
      {children}
    </section>
  );
}
