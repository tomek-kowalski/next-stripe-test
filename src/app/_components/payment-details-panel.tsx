"use client";

import type { LedgerEntry } from "@/lib/lab/connect/ledger";
import type { PaymentDetails } from "./api";
import { dateTime, MODEL_PL, pln, STATUS_PL } from "./api";

function Status({ value }: { value: string | null | undefined }) {
  if (!value) return <span>—</span>;
  return (
    <span>
      <code>{value}</code>
      {STATUS_PL[value] && <span className="text-zinc-500"> ({STATUS_PL[value]})</span>}
    </span>
  );
}

function Ledger({ title, entries }: { title: string; entries: LedgerEntry[] }) {
  return (
    <div className="min-w-0">
      <h4 className="font-bold">{title}</h4>
      {entries.length === 0 ? (
        <p className="text-zinc-500">Brak transakcji salda (balance transactions).</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr><th>ID</th><th>type</th><th>source</th><th>amount</th><th>fee</th><th>net</th><th>status</th><th>available_on</th></tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap">{e.id}</td>
                  <td>{e.type}</td>
                  <td className="whitespace-nowrap">{e.source}</td>
                  <td className="text-right">{pln(e.amount)}</td>
                  <td className="text-right">{e.fee ? pln(e.fee) : "—"}</td>
                  <td className="text-right font-bold">{pln(e.net)}</td>
                  <td><span className={e.status === "available" ? "badge badge-ok" : "badge badge-warn"}>{e.status}</span></td>
                  <td className="whitespace-nowrap">{e.available_on_iso.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Money({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded border border-zinc-300 p-2 dark:border-zinc-700">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-base font-bold">{pln(value)}</div>
      {hint && <div className="text-xs text-zinc-500">{hint}</div>}
    </div>
  );
}

export function PaymentDetailsPanel({ details, loading }: { details: PaymentDetails | null; loading: boolean }) {
  if (!details) {
    return (
      <section className="panel" data-testid="details-panel">
        <h2 className="font-bold">Szczegóły transakcji</h2>
        <p className="text-zinc-500">{loading ? "Wczytywanie z Stripe…" : "Autoryzuj nową płatność albo wczytaj PaymentIntent po ID."}</p>
      </section>
    );
  }
  const { summary: s, objects: o, funds: f } = details;
  return (
    <section className="panel space-y-3" data-testid="details-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-bold">Szczegóły transakcji — {MODEL_PL[s.connect.charge_model]}</h2>
        <span className="text-xs text-zinc-500">stan ze Stripe: {dateTime(details.fetchedAt)}{loading && " · odświeżanie…"}</span>
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt>PaymentIntent</dt><dd className="break-all">{s.id} · <Status value={s.status} /></dd>
        <dt>Kwota / przechwycono</dt><dd>{pln(s.amount)} / {pln(s.amount_received)} · amount_capturable {pln(s.amount_capturable)} · capture_method <code>{s.capture_method}</code></dd>
        <dt>Charge</dt><dd className="break-all">{o.charge ? <>{o.charge.id} · <Status value={o.charge.status} /> · captured={String(o.charge.captured)} · amount_captured {pln(o.charge.amount_captured)} · amount_refunded {pln(o.charge.amount_refunded)}</> : "—"}</dd>
        <dt>Konto sprzedawcy</dt><dd>{details.sellerAccountId ?? "— (płatność platformowa)"}</dd>
        {s.connect.transfer_group && (<><dt>transfer_group</dt><dd className="break-all">{s.connect.transfer_group}</dd></>)}
        <dt>Transfer(y)</dt>
        <dd className="break-all">
          {o.transfers.length === 0 ? "—" : o.transfers.map((t) => (
            <div key={t.id}>{t.id} · {pln(t.amount)} · cofnięto {pln(t.amount_reversed)}{t.reversed && " (w całości)"} · destination_payment {t.destination_payment ?? "—"}</div>
          ))}
          {o.transferReversals.map((r) => <div key={r.id} className="text-zinc-500">↳ reversal {r.id} · {pln(r.amount)}</div>)}
        </dd>
        <dt>Refund(y)</dt>
        <dd className="break-all">
          {o.refunds.length === 0 ? "—" : o.refunds.map((r) => (
            <div key={r.id}>{r.id} · {pln(r.amount)} · <Status value={r.status} />{r.transfer_reversal && ` · transfer_reversal ${r.transfer_reversal}`}</div>
          ))}
        </dd>
        <dt>Application Fee</dt>
        <dd className="break-all">
          {o.applicationFee ? <>{o.applicationFee.id} · {pln(o.applicationFee.amount)} · zwrócono {pln(o.applicationFee.amount_refunded)}{o.applicationFee.refundIds.length > 0 && ` · ${o.applicationFee.refundIds.join(", ")}`}</> : s.connect.application_fee_amount !== null ? `application_fee_amount ${pln(s.connect.application_fee_amount)} (Application Fee powstaje przy przechwyceniu)` : "—"}
        </dd>
      </dl>

      <div>
        <h3 className="mb-1 font-bold">Rozliczenie tej płatności (z balance transactions)</h3>
        <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
          <Money label="Opłata Stripe (rzeczywista)" value={f.stripeFees} hint="pobrana od platformy, netto po ewentualnych zwrotach opłat" />
          <Money label="Prowizja platformy (application fee netto)" value={f.applicationFeeNet} hint="tylko Destination Charge" />
          <Money label="Przekazano sprzedawcy (transferred)" value={f.transferredToSeller} hint="przelewy minus cofnięcia" />
          <Money label="Przychód netto platformy" value={f.platformNet} hint={`oczekujące ${pln(f.platformPending)} · dostępne ${pln(f.platformAvailable)}`} />
          <Money label="Środki sprzedawcy z tej płatności" value={f.sellerNet} hint={`oczekujące ${pln(f.sellerPending)} · dostępne ${pln(f.sellerAvailable)}`} />
          <div className="rounded border border-zinc-300 p-2 dark:border-zinc-700">
            <div className="text-xs text-zinc-500">Przewalutowanie</div>
            <div className="text-base font-bold">{f.currencyConversion ? "TAK" : "brak"}</div>
            <div className="text-xs text-zinc-500">{f.currencyConversion ? "wykryto exchange_rate" : "wszystkie transakcje w PLN"}</div>
          </div>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          <b>pending</b> = zaksięgowane, nierozliczone · <b>available</b> = dostępne do wypłaty · <b>transferred</b> = przesunięte z salda
          platformy na saldo sprzedawcy (nadal może być pending). Udany wynik API nie oznacza rozliczenia środków.
        </p>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Ledger title="Platforma — balance transactions" entries={details.ledger.platform} />
        <Ledger title="Sprzedawca (konto połączone) — balance transactions" entries={details.ledger.connected} />
      </div>
    </section>
  );
}
