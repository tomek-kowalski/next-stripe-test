"use client";

import { useEffect, useState } from "react";
import type { Booking, ScenarioLetter, TestPaymentMethod } from "@/lib/lab/schemas";
import type { OperationResult } from "@/lib/lab/types";
import type { BookingListItem } from "@/lib/lab/bookings";
import { AccountsPanel } from "./accounts-panel";
import { bookingDatesError, resolveBookingDates } from "./booking-dates";
import type { AccountRow, AccountsResponse, ApiResult, BalanceResponse, PaymentDetails } from "./api";
import { api, dateTime, newKey, pln, STATUS_PL } from "./api";
import { ExpirySimulation } from "./expiry-simulation";
import { Explain, ResultCard, ScenarioIntro, Steps, type NextAction } from "./guided";
import type { HistoryEntry } from "./history-panel";
import { readMoney } from "./money";
import { ZlInput } from "./zl-input";

export type TabId = "booking" | "A" | "B" | "C" | "compare" | "refund" | "expiry" | "accounts";

export const TABS: { id: TabId; label: string }[] = [
  { id: "booking", label: "Rezerwacja" },
  { id: "A", label: "A — Kaucja pobrana od razu" },
  { id: "B", label: "B — Autoryzacja, pobranie później" },
  { id: "C", label: "C — Opóźniony przelew" },
  { id: "compare", label: "Porównanie A / B / C" },
  { id: "refund", label: "Zwrot pieniędzy" },
  { id: "expiry", label: "Wygaśnięcie blokady" },
  { id: "accounts", label: "Konta sprzedawców" },
];

/** Booking form state; the id is assigned on the first payment and dates default at run time. */
export type BookingDraft = {
  id: string | null;
  item: string;
  customer: string;
  start: string;
  end: string;
  amount: number | null;
  feePercent: string;
};

export type Runs = Partial<Record<ScenarioLetter, string>>;

type Perform = <T>(label: string, call: () => Promise<ApiResult<T>>) => Promise<ApiResult<T>>;

export type ScenarioCtx = {
  details: PaymentDetails | null;
  busy: boolean;
  labAccount: AccountRow | null;
  maxAmount: number;
  card: TestPaymentMethod;
  booking: BookingDraft;
  setBooking: (b: BookingDraft) => void;
  runs: Runs;
  setRun: (letter: ScenarioLetter, id: string | null) => void;
  perform: Perform;
  show: (id: string) => void;
  go: (tab: TabId) => void;
  clear: () => void;
};

// ---------- booking helpers ----------

export const newBookingId = () => `bk_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

export function feeOf(b: BookingDraft): number | null {
  const pct = Number(b.feePercent.replace(",", "."));
  if (b.amount === null || !Number.isFinite(pct) || pct < 0 || pct >= 100) return null;
  return Math.round((b.amount * pct) / 100);
}

/** Resolves defaults (id, dates) at the moment of the first payment, so render stays deterministic. */
function resolveBooking(ctx: ScenarioCtx, scenario: ScenarioLetter): Booking {
  const b = ctx.booking;
  const resolved = {
    id: b.id ?? newBookingId(),
    scenario,
    item: b.item.trim() || "Wiertarka udarowa",
    customer: b.customer.trim() || "Klient testowy",
    ...resolveBookingDates(b.start, b.end, new Date()),
  };
  if (resolved.id !== b.id || resolved.start !== b.start || resolved.end !== b.end) {
    ctx.setBooking({ ...b, id: resolved.id, start: resolved.start, end: resolved.end });
  }
  return resolved;
}

// ---------- actions (all executed by Stripe Sandbox through the lab API) ----------

async function runScenario(ctx: ScenarioCtx, letter: ScenarioLetter): Promise<string | null> {
  const booking = resolveBooking(ctx, letter);
  const fee = feeOf(ctx.booking);
  const params = {
    A: { chargeModel: "destination", captureMethod: "automatic", applicationFeeAmount: fee },
    B: { chargeModel: "destination", captureMethod: "manual", applicationFeeAmount: fee },
    C: { chargeModel: "separate", captureMethod: "automatic" },
  }[letter];
  const created = await ctx.perform<OperationResult>(`Scenariusz ${letter} — przygotowanie płatności`, () =>
    api("POST", "/api/lab/payment-intents", {
      amount: ctx.booking.amount,
      accountId: ctx.labAccount?.id,
      booking,
      scenario: `booking-${letter.toLowerCase()}`,
      ...params,
      idempotencyKey: newKey(),
    }),
  );
  if (!created.ok || !created.body.ok) return null;
  const id = created.body.summary.id;
  ctx.setRun(letter, id);
  ctx.show(id);
  const confirmed = await ctx.perform(`Scenariusz ${letter} — ${letter === "B" ? "autoryzacja (blokada)" : "płatność"} kartą klienta`, () =>
    api("POST", `/api/lab/payment-intents/${id}/confirm`, { paymentMethod: ctx.card, idempotencyKey: newKey() }),
  );
  ctx.show(id);
  return confirmed.ok ? id : null;
}

const capture = (ctx: ScenarioCtx, d: PaymentDetails, amount?: number) => {
  const s = d.summary;
  const fee =
    amount !== undefined && s.connect.charge_model === "destination" && s.connect.application_fee_amount !== null
      ? Math.round((s.connect.application_fee_amount * amount) / s.amount)
      : undefined;
  return ctx
    .perform(amount === undefined ? "Pobranie całej kaucji" : `Pobranie ${pln(amount)} z kaucji`, () =>
      api("POST", `/api/lab/payment-intents/${s.id}/capture`, {
        ...(amount !== undefined && { amountToCapture: amount }),
        ...(fee !== undefined && { applicationFeeAmount: fee }),
        idempotencyKey: newKey(),
      }),
    )
    .then(() => ctx.show(s.id));
};

const cancel = (ctx: ScenarioCtx, d: PaymentDetails) =>
  ctx
    .perform("Zwolnienie blokady", () => api("POST", `/api/lab/payment-intents/${d.summary.id}/cancel`, { cancellationReason: "requested_by_customer", idempotencyKey: newKey() }))
    .then(() => ctx.show(d.summary.id));

const refund = (ctx: ScenarioCtx, d: PaymentDetails, amount: number | undefined, recover: boolean, waiveFee: boolean) =>
  ctx
    .perform(amount === undefined ? "Zwrot całej kwoty" : `Zwrot ${pln(amount)}`, () =>
      api("POST", `/api/lab/payment-intents/${d.summary.id}/refund`, {
        ...(amount !== undefined && { amount }),
        ...(d.summary.connect.charge_model === "destination" && { reverseTransfer: recover, refundApplicationFee: waiveFee }),
        idempotencyKey: newKey(),
      }),
    )
    .then(() => ctx.show(d.summary.id));

const transfer = (ctx: ScenarioCtx, d: PaymentDetails, amount: number) =>
  ctx
    .perform(`Przelew ${pln(amount)} do sprzedawcy`, () => api("POST", "/api/lab/transfers", { paymentIntentId: d.summary.id, amount, idempotencyKey: newKey() }))
    .then(() => ctx.show(d.summary.id));

const reverse = (ctx: ScenarioCtx, d: PaymentDetails, transferId: string) =>
  ctx
    .perform("Cofnięcie przelewu od sprzedawcy", () => api("POST", `/api/lab/transfers/${transferId}/reversals`, { idempotencyKey: newKey() }))
    .then(() => ctx.show(d.summary.id));

// ---------- shared UI ----------

function startReason(ctx: ScenarioCtx): string | null {
  const b = ctx.booking;
  if (b.amount === null) return "podaj kwotę w zakładce Rezerwacja";
  if (b.amount > ctx.maxAmount) return `maksymalnie ${pln(ctx.maxAmount)}`;
  if (feeOf(b) === null) return "prowizja musi być od 0 do 99%";
  if (bookingDatesError(b.start, b.end)) return "data zakończenia rezerwacji jest wcześniejsza niż data rozpoczęcia (zakładka Rezerwacja)";
  if (!ctx.labAccount) return "brak konta sprzedawcy laboratorium";
  if (!ctx.labAccount.readiness?.ready) return "konto sprzedawcy laboratorium nie jest gotowe (zakładka Konta sprzedawców)";
  return null;
}

function Primary({ label, reason, onClick, busy, testId }: { label: string; reason: string | null; onClick: () => void; busy: boolean; testId?: string }) {
  return (
    <span className="inline-block">
      <button className="btn btn-primary" disabled={busy || !!reason} onClick={onClick} data-testid={testId}>{label}</button>
      {reason && <span className="ml-2 text-xs text-zinc-500">Niedostępne: {reason}</span>}
    </span>
  );
}

function Technical({ children }: { children: React.ReactNode }) {
  return (
    <details className="text-xs text-zinc-600 dark:text-zinc-400">
      <summary className="cursor-pointer">Jak to wygląda w Stripe (szczegóły techniczne)</summary>
      <div className="mt-1 space-y-1">{children}</div>
    </details>
  );
}

type Expectation = { label: string; expected: string; actual: string; pass: boolean | null };

/** Expected result from the study plan next to the actual Sandbox result. pass=null: not reached yet. */
function ExpectedVsActual({ rows }: { rows: Expectation[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="table" data-testid="expected-vs-actual">
        <thead><tr><th>Sprawdzenie</th><th>Oczekiwany wynik</th><th>Rzeczywisty wynik (Stripe Sandbox)</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td>{r.expected}</td>
              <td>{r.actual}</td>
              <td className={r.pass === null ? "text-zinc-400" : r.pass ? "text-green-700 dark:text-green-400" : "text-red-600"}>
                {r.pass === null ? "—" : r.pass ? "✓ zgodne" : "✗ niezgodne"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BookingSummary({ ctx }: { ctx: ScenarioCtx }) {
  const b = ctx.booking;
  const fee = feeOf(b);
  return (
    <p className="rounded bg-zinc-100 p-2 dark:bg-zinc-900">
      Rezerwacja <b>{b.id ?? "(nowa — numer nadany przy pierwszej płatności)"}</b>: {b.item || "Wiertarka udarowa"}, klient {b.customer || "Klient testowy"},
      kwota <b>{b.amount !== null ? pln(b.amount) : "—"}</b>, prowizja platformy <b>{fee !== null ? pln(fee) : "—"}</b>
      {b.amount !== null && fee !== null && <> → sprzedawca <b>{pln(b.amount - fee)}</b></>}.{" "}
      <button className="underline" onClick={() => ctx.go("booking")}>zmień</button>
    </p>
  );
}

/** The payment shown in a scenario tab: only this scenario's run for the current booking. */
function runDetails(ctx: ScenarioCtx, letter: ScenarioLetter): PaymentDetails | null {
  const id = ctx.runs[letter];
  return id && ctx.details?.summary.id === id ? ctx.details : null;
}

function RunButton({ ctx, letter, d, label }: { ctx: ScenarioCtx; letter: ScenarioLetter; d: PaymentDetails | null; label: string }) {
  const reason = startReason(ctx);
  return d ? (
    <span className="inline-block">
      <button className="btn" disabled={ctx.busy || !!reason} onClick={() => void runScenario(ctx, letter)}>Uruchom scenariusz {letter} ponownie (nowa płatność)</button>
    </span>
  ) : (
    <Primary label={label} reason={reason} busy={ctx.busy} testId={`run-${letter}`} onClick={() => void runScenario(ctx, letter)} />
  );
}

/** Next steps offered in the result card, derived from the real state of the payment. */
export function nextActionsFor(ctx: ScenarioCtx): NextAction[] {
  const d = ctx.details;
  if (!d) return [];
  const m = readMoney(d);
  const s = d.summary;
  const out: NextAction[] = [];
  if (s.status === "requires_capture") {
    out.push({ label: "Pobierz kaucję (scenariusz B)", onClick: () => ctx.go("B") });
    out.push({ label: "Zwolnij blokadę", onClick: () => void cancel(ctx, d) });
    out.push({ label: "Zobacz termin wygaśnięcia", onClick: () => ctx.go("expiry") });
  }
  if (m.transferable > 0) out.push({ label: "Przekaż pieniądze sprzedawcy (scenariusz C)", onClick: () => ctx.go("C") });
  if (s.status === "succeeded" && m.refundable > 0) out.push({ label: "Zwróć pieniądze klientowi", onClick: () => ctx.go("refund") });
  if (m.reversibleTransferId && m.refunded > 0) out.push({ label: "Cofnij przelew od sprzedawcy", onClick: () => ctx.go("refund") });
  out.push({ label: "Porównaj A / B / C", onClick: () => ctx.go("compare") });
  return out;
}

/** Result card with next steps computed from the scenario context. */
export function ScenarioResult({ ctx, loading, lastEntry }: { ctx: ScenarioCtx; loading: boolean; lastEntry: HistoryEntry | null }) {
  return <ResultCard details={ctx.details} loading={loading} lastEntry={lastEntry} next={nextActionsFor(ctx)} />;
}

// ---------- Rezerwacja ----------

export function BookingPanel({ ctx }: { ctx: ScenarioCtx }) {
  const b = ctx.booking;
  const fee = feeOf(b);
  const [list, setList] = useState<BookingListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const loadList = () =>
    api<{ bookings: BookingListItem[] }>("GET", "/api/lab/bookings").then((r) => {
      if (r.ok) setList(r.body.bookings);
      else setListError(r.body.message ?? "Nie udało się wczytać rezerwacji.");
    });
  useEffect(() => {
    void api<{ bookings: BookingListItem[] }>("GET", "/api/lab/bookings").then((r) => {
      if (r.ok) setList(r.body.bookings);
      else setListError(r.body.message ?? "Nie udało się wczytać rezerwacji.");
    });
  }, []);
  const set = (patch: Partial<BookingDraft>) => ctx.setBooking({ ...b, ...patch });
  const open = (item: BookingListItem) => {
    const runs: Runs = {};
    for (const r of item.runs) if (r.scenario === "A" || r.scenario === "B" || r.scenario === "C") runs[r.scenario] = r.paymentIntentId;
    const first = item.runs[0];
    ctx.setBooking({ ...b, id: item.id, item: item.item ?? "", customer: item.customer ?? "", start: item.start ?? "", end: item.end ?? "", amount: first?.amount ?? b.amount });
    (["A", "B", "C"] as const).forEach((l) => ctx.setRun(l, runs[l] ?? null));
    ctx.go("compare");
  };

  return (
    <ScenarioIntro title="Wspólna rezerwacja dla scenariuszy A, B i C">
      <p>
        Jedna rezerwacja (wynajem przedmiotu od sprzedawcy) jest rozliczana na trzy sposoby. Każdy scenariusz tworzy własną,
        prawdziwą płatność w Stripe Sandbox z tymi samymi danymi, dzięki czemu wyniki można porównać.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block"><span className="font-bold">Przedmiot</span>
          <input value={b.item} placeholder="Wiertarka udarowa" onChange={(e) => set({ item: e.target.value })} maxLength={60} className="mt-1 block w-full rounded border px-2 py-1" />
        </label>
        <label className="block"><span className="font-bold">Klient</span>
          <input value={b.customer} placeholder="Klient testowy" onChange={(e) => set({ customer: e.target.value })} maxLength={60} className="mt-1 block w-full rounded border px-2 py-1" />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block"><span className="font-bold">Od</span>
            <input type="date" value={b.start} onChange={(e) => set({ start: e.target.value })} className="mt-1 block w-full rounded border px-2 py-1" />
          </label>
          <label className="block"><span className="font-bold">Do</span>
            <input type="date" value={b.end} min={b.start || undefined} onChange={(e) => set({ end: e.target.value })} className={`mt-1 block w-full rounded border px-2 py-1 ${bookingDatesError(b.start, b.end) ? "border-red-500" : ""}`} />
          </label>
          {bookingDatesError(b.start, b.end) ? (
            <span className="col-span-2 text-xs text-red-600" data-testid="booking-dates-error">{bookingDatesError(b.start, b.end)}</span>
          ) : (
            <span className="col-span-2 text-xs text-zinc-500">Puste daty: od dziś; koniec domyślnie 3 dni po rozpoczęciu.</span>
          )}
        </div>
        <ZlInput label="Kwota (kaucja / płatność)" value={b.amount} onChange={(amount) => set({ amount })} help="Domyślnie 100 zł" testId="booking-amount" />
        <label className="block"><span className="font-bold">Prowizja platformy</span>
          <span className="mt-1 flex items-center gap-1">
            <input value={b.feePercent} onChange={(e) => set({ feePercent: e.target.value })} inputMode="decimal" className="w-16 rounded border px-2 py-1 text-right" />%
          </span>
          <span className="text-xs text-zinc-500">{fee !== null && b.amount !== null ? `= ${pln(fee)}; sprzedawca ${pln(b.amount - fee)}` : "od 0 do 99%"}</span>
        </label>
        <div className="text-xs text-zinc-500">Sprzedawca: konto testowe laboratorium {ctx.labAccount?.id ?? "—"}. Waluta: PLN.</div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" onClick={() => ctx.go("A")}>Dalej: scenariusz A →</button>
        <button className="btn" onClick={() => { ctx.setBooking({ ...b, id: null }); (["A", "B", "C"] as const).forEach((l) => ctx.setRun(l, null)); ctx.clear(); }}>
          Nowa rezerwacja (wyczyść A/B/C)
        </button>
      </div>

      <div className="grid gap-2 md:grid-cols-3">
        {[
          ["A — Kaucja pobrana od razu", "Destination Charge: klient płaci od razu; Stripe przekazuje sprzedawcy 90%, platforma zatrzymuje 10%."],
          ["B — Autoryzacja, pobranie później", "Destination Charge z ręcznym pobraniem: najpierw tylko blokada na karcie, podział dopiero przy pobraniu."],
          ["C — Opóźniony przelew", "Separate Charges and Transfers: platforma pobiera całość i sama decyduje, kiedy przekazać 90% sprzedawcy."],
        ].map(([t, x]) => (
          <div key={t} className="rounded border border-zinc-300 p-2 dark:border-zinc-700"><b>{t}</b><div className="text-xs">{x}</div></div>
        ))}
      </div>

      <div>
        <div className="flex items-baseline gap-2">
          <h3 className="font-bold">Wcześniejsze rezerwacje laboratorium</h3>
          <button className="btn" onClick={() => void loadList()}>Odśwież</button>
        </div>
        <p className="text-xs text-zinc-500">Bez bazy danych: lista jest odtwarzana z metadanych płatności przez wyszukiwarkę Stripe, która może pokazywać nowe płatności z opóźnieniem (zwykle do minuty).</p>
        {listError && <p className="text-red-600">{listError}</p>}
        {list && list.length === 0 && <p className="text-zinc-500">Brak rezerwacji.</p>}
        {list && list.length > 0 && (
          <ul className="space-y-1">
            {list.slice(0, 15).map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-2">
                <button className="btn" onClick={() => open(item)}>Wczytaj</button>
                <span><b>{item.id}</b> · {item.item} · {item.customer} · {item.start} – {item.end} · scenariusze: {item.runs.map((r) => `${r.scenario} (${STATUS_PL[r.status] ?? r.status})`).join(", ")}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ScenarioIntro>
  );
}

// ---------- A — Kaucja pobrana od razu ----------

export function ScenarioA({ ctx }: { ctx: ScenarioCtx }) {
  const d = runDetails(ctx, "A");
  const m = d ? readMoney(d) : null;
  const amount = d?.summary.amount ?? ctx.booking.amount ?? 0;
  const fee = d?.summary.connect.application_fee_amount ?? feeOf(ctx.booking) ?? 0;
  const paid = d?.summary.status === "succeeded";
  return (
    <ScenarioIntro title="Scenariusz A — kaucja pobrana od razu (Destination Charge)">
      <BookingSummary ctx={ctx} />
      <Explain
        action={`Klient płaci ${pln(amount)} od razu przy rezerwacji.`}
        customer={`${pln(amount)} schodzi z karty natychmiast.`}
        seller={`Stripe automatycznie przekazuje sprzedawcy ${pln(amount - fee)}.`}
        platform={`Platforma zatrzymuje prowizję ${pln(fee)} i płaci z niej opłatę Stripe.`}
      />
      <Steps
        steps={[
          { title: "Klient płaci kartą", text: "Obciążenie natychmiastowe (bez blokady).", done: paid },
          { title: "Stripe przekazuje pieniądze sprzedawcy", text: "Automatycznie, przy pobraniu.", done: !!m && m.transfersGross > 0 },
          { title: "Prowizja wraca do platformy", text: "Stripe tworzy ją kilka sekund później.", done: !!m && m.commissionGross > 0 },
          { title: "Wynik zgodny z planem", text: "Sprawdzenie poniżej.", done: !!m && m.sellerNet === amount - fee && m.commissionGross - m.commissionRefunded === fee },
        ]}
      />
      <RunButton ctx={ctx} letter="A" d={d} label={`Uruchom scenariusz A: klient płaci ${pln(ctx.booking.amount ?? 0)}`} />
      <ExpectedVsActual
        rows={[
          { label: "Płatność", expected: `pobrano ${pln(amount)} od razu`, actual: d ? `${STATUS_PL[d.summary.status] ?? d.summary.status}, pobrano ${pln(m!.captured)}` : "—", pass: d ? paid && m!.captured === amount : null },
          { label: "Sprzedawca", expected: pln(amount - fee), actual: m ? pln(m.sellerNet) : "—", pass: m && m.commissionGross > 0 ? m.sellerNet === amount - fee : null },
          { label: "Prowizja platformy", expected: pln(fee), actual: m ? pln(m.commissionGross - m.commissionRefunded) : "—", pass: m && m.commissionGross > 0 ? m.commissionGross - m.commissionRefunded === fee : null },
          { label: "Opłata Stripe (informacyjnie)", expected: "pobierana od platformy", actual: m ? pln(m.stripeFee) : "—", pass: null },
        ]}
      />
      <Technical>
        <p><code>PaymentIntent</code> z <code>capture_method: automatic</code>, <code>transfer_data.destination</code> = konto sprzedawcy i <code>application_fee_amount</code> = prowizja. Stripe przelewa sprzedawcy całą kwotę, a obiekt <code>Application Fee</code> oddaje prowizję platformie (asynchronicznie, ok. 3–4 s).</p>
      </Technical>
    </ScenarioIntro>
  );
}

// ---------- B — Autoryzacja, pobranie później ----------

export function ScenarioB({ ctx }: { ctx: ScenarioCtx }) {
  const [part, setPart] = useState<number | null>(5000);
  const d = runDetails(ctx, "B");
  const m = d ? readMoney(d) : null;
  const st = d?.summary.status;
  const amount = d?.summary.amount ?? ctx.booking.amount ?? 0;
  const fee = d?.summary.connect.application_fee_amount ?? feeOf(ctx.booking) ?? 0;
  const held = st === "requires_capture";
  const noMoneyMoved = !!d && d.objects.charge?.amount_captured === 0 && d.objects.transfers.length === 0 && d.ledger.platform.length === 0 && d.ledger.connected.length === 0;
  const capturedFee = m ? m.commissionGross - m.commissionRefunded : 0;
  const partReason = !held ? "brak aktywnej blokady" : part === null ? "podaj kwotę" : part >= d!.summary.amount_capturable ? `część musi być mniejsza niż ${pln(d!.summary.amount_capturable)}` : null;
  return (
    <ScenarioIntro title="Scenariusz B — autoryzacja teraz, pobranie później (Destination Charge, ręczne pobranie)">
      <BookingSummary ctx={ctx} />
      <Explain
        action={`Platforma blokuje ${pln(amount)} na karcie klienta i decyduje później: pobrać całość, część albo zwolnić.`}
        customer="Do chwili pobrania pieniądze są tylko zablokowane — nic nie schodzi z konta."
        seller={`Sprzedawca nic nie dostaje, dopóki kaucja nie zostanie pobrana; potem ${pln(amount - fee)} (przy pełnym pobraniu).`}
        platform="Blokada nic nie kosztuje. Prowizja i opłata Stripe pojawiają się dopiero przy pobraniu."
      />
      <Steps
        steps={[
          { title: "Autoryzacja: blokada na karcie", text: "Bank klienta potwierdza blokadę (do 7 dni).", done: !!d && ["requires_capture", "succeeded", "canceled"].includes(st!) },
          { title: "Sprawdzenie: nic nie pobrano", text: "Brak pobranych środków, przelewów i transakcji salda.", done: !!d && (held ? noMoneyMoved : st === "succeeded" || st === "canceled") },
          { title: "Decyzja: pobierz albo zwolnij", text: "Pobranie całości lub części; reszta blokady wraca do klienta.", done: st === "succeeded" || st === "canceled" },
          { title: "Podział przy pobraniu", text: "Stripe przekazuje sprzedawcy jego część, prowizja wraca do platformy.", done: !!m && st === "succeeded" && m.commissionGross > 0 },
        ]}
      />
      <div className="flex flex-wrap items-end gap-3">
        {!held && <RunButton ctx={ctx} letter="B" d={d} label={`Uruchom scenariusz B: zablokuj ${pln(ctx.booking.amount ?? 0)}`} />}
        {held && (
          <>
            <Primary label={`Pobierz całą kaucję (${pln(d!.summary.amount_capturable)})`} reason={null} busy={ctx.busy} testId="b-capture-full" onClick={() => void capture(ctx, d!)} />
            <span className="flex items-end gap-2">
              <ZlInput label="albo pobierz część" value={part} onChange={setPart} help="prowizja liczona proporcjonalnie" />
              <Primary label="Pobierz część" reason={partReason} busy={ctx.busy} onClick={() => void capture(ctx, d!, part!)} />
            </span>
            <button className="btn" disabled={ctx.busy} onClick={() => void cancel(ctx, d!)}>Zwolnij blokadę (brak szkody)</button>
          </>
        )}
      </div>
      <ExpectedVsActual
        rows={[
          { label: "Przed pobraniem", expected: "brak pobranych środków", actual: !d ? "—" : held ? (noMoneyMoved ? "pobrano 0,00 zł, brak przelewów i transakcji salda" : "trwa zapisywanie danych…") : "etap zakończony", pass: d && held ? noMoneyMoved : null },
          { label: "Po pełnym pobraniu: sprzedawca", expected: pln(amount - fee), actual: m && st === "succeeded" ? pln(m.sellerNet) : "—", pass: m && st === "succeeded" && m.commissionGross > 0 && m.captured === amount ? m.sellerNet === amount - fee : null },
          { label: "Po pełnym pobraniu: prowizja", expected: pln(fee), actual: m && st === "succeeded" ? pln(capturedFee) : "—", pass: m && st === "succeeded" && m.commissionGross > 0 && m.captured === amount ? capturedFee === fee : null },
          { label: "Zwolnienie blokady (jeśli wybrane)", expected: "0,00 zł kosztów", actual: st === "canceled" ? `platforma ${pln(m!.platformNet)}` : "—", pass: st === "canceled" ? m!.platformNet === 0 : null },
        ]}
      />
      <Technical>
        <p><code>capture_method: manual</code> + <code>transfer_data.destination</code> + <code>application_fee_amount</code>. Status <code>requires_capture</code> = aktywna blokada; przelew i <code>Application Fee</code> powstają dopiero przy <code>capture</code>. Przy częściowym pobraniu prowizja jest ustawiana ponownie (<code>application_fee_amount</code> przy capture).</p>
      </Technical>
    </ScenarioIntro>
  );
}

// ---------- C — Opóźniony przelew ----------

export function ScenarioC({ ctx }: { ctx: ScenarioCtx }) {
  const d = runDetails(ctx, "C");
  const m = d ? readMoney(d) : null;
  const amount = d?.summary.amount ?? ctx.booking.amount ?? 0;
  const fee = feeOf(ctx.booking) ?? 0;
  const [toSeller, setToSeller] = useState<number | null>(null);
  const transferAmount = toSeller ?? amount - fee;
  const paid = d?.summary.status === "succeeded";
  const transferReason = !paid ? "najpierw uruchom scenariusz C (płatność klienta)" : m!.transferable <= 0 ? "nie ma już środków z tej płatności do przekazania" : transferAmount > m!.transferable ? `maksymalnie ${pln(m!.transferable)}` : null;
  const transferred = !!m && m.transfersGross > 0;
  return (
    <ScenarioIntro title="Scenariusz C — opóźniony przelew (Separate Charges and Transfers)">
      <BookingSummary ctx={ctx} />
      <Explain
        action={`Klient płaci ${pln(amount)} platformie; platforma przekazuje sprzedawcy ${pln(amount - fee)} wtedy, kiedy zdecyduje (np. po zwrocie przedmiotu).`}
        customer={`${pln(amount)} schodzi z karty od razu.`}
        seller="Sprzedawca nic nie ma, dopóki platforma nie wykona przelewu."
        platform="Platforma trzyma całość do przelewu, zatrzymuje różnicę jako prowizję i płaci opłatę Stripe."
      />
      <Steps
        steps={[
          { title: "Klient płaci platformie", text: "Pieniądze trafiają tylko na konto platformy.", done: paid },
          { title: "Pieniądze czekają na platformie", text: "Sprzedawca ma 0,00 zł — platforma kontroluje moment przelewu.", done: paid },
          { title: "Platforma przekazuje pieniądze sprzedawcy", text: "Osobny przelew finansowany z tej płatności.", done: transferred },
          { title: "Wynik zgodny z planem", text: "Sprawdzenie poniżej.", done: !!m && transferred && m.sellerNet === amount - fee },
        ]}
      />
      <div className="flex flex-wrap items-end gap-4">
        <RunButton ctx={ctx} letter="C" d={d} label={`Uruchom scenariusz C: klient płaci ${pln(ctx.booking.amount ?? 0)}`} />
        <span className="flex items-end gap-2">
          <ZlInput key={`${d?.summary.id}-${amount - fee}`} label="Przekaż sprzedawcy" value={transferAmount} onChange={setToSeller} help={m && paid ? `do przekazania: ${pln(Math.max(m.transferable, 0))}` : undefined} />
          <Primary label={`Przekaż sprzedawcy ${pln(transferAmount)}`} reason={transferReason} busy={ctx.busy} testId="c-transfer" onClick={() => void transfer(ctx, d!, transferAmount)} />
        </span>
      </div>
      <ExpectedVsActual
        rows={[
          { label: "Po płatności, przed przelewem", expected: "sprzedawca 0,00 zł; całość na platformie", actual: m && paid && !transferred ? `sprzedawca ${pln(m.sellerNet)}, platforma ${pln(m.platformNet)}` : transferred ? "etap zakończony" : "—", pass: m && paid && !transferred ? m.sellerNet === 0 : null },
          { label: "Po przelewie: sprzedawca", expected: pln(amount - fee), actual: transferred ? pln(m!.sellerNet) : "—", pass: transferred ? m!.sellerNet === amount - fee : null },
          { label: "Po przelewie: platforma zatrzymuje", expected: pln(fee), actual: transferred ? pln(m!.keptBySeparate) : "—", pass: transferred ? m!.keptBySeparate === fee : null },
          { label: "Opłata Stripe (informacyjnie)", expected: "pobierana od platformy", actual: m ? pln(m.stripeFee) : "—", pass: null },
        ]}
      />
      <Technical>
        <p>Obciążenie na platformie z <code>transfer_group</code>, potem <code>POST /v1/transfers</code> z <code>source_transaction</code> (przelew finansowany z tej płatności, nie z wolnego salda). Nie ma obiektu prowizji — zarobek platformy to część nieprzekazana.</p>
      </Technical>
    </ScenarioIntro>
  );
}

// ---------- Porównanie A / B / C ----------

export function ComparePanel({ ctx }: { ctx: ScenarioCtx }) {
  const [rows, setRows] = useState<Partial<Record<ScenarioLetter, PaymentDetails | string>>>({});
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const runsKey = JSON.stringify(ctx.runs);

  useEffect(() => {
    const runs = JSON.parse(runsKey) as Runs;
    void Promise.all(
      (["A", "B", "C"] as const).map(async (l) => {
        const id = runs[l];
        if (!id) return [l, undefined] as const;
        const r = await api<PaymentDetails>("GET", `/api/lab/payment-intents/${id}/details`);
        return [l, r.ok ? r.body : (r.body.message ?? "błąd")] as const;
      }),
    ).then((entries) => {
      setRows(Object.fromEntries(entries.filter(([, v]) => v !== undefined)));
      setFetchedAt(new Date().toISOString());
    });
  }, [runsKey, ctx.busy]);

  const cols = (["A", "B", "C"] as const).map((l) => {
    const v = rows[l];
    return { l, d: typeof v === "object" ? v : null, err: typeof v === "string" ? v : null };
  });
  const line = (label: string, f: (d: PaymentDetails) => string) => (
    <tr key={label}><td className="font-bold">{label}</td>{cols.map((c) => <td key={c.l}>{c.d ? f(c.d) : c.err ?? "nie uruchomiono"}</td>)}</tr>
  );
  return (
    <ScenarioIntro title="Porównanie scenariuszy A / B / C dla tej samej rezerwacji">
      <BookingSummary ctx={ctx} />
      <div className="overflow-x-auto">
        <table className="table" data-testid="compare">
          <thead>
            <tr><th></th><th>A — od razu</th><th>B — autoryzacja</th><th>C — opóźniony przelew</th></tr>
            <tr className="text-xs text-zinc-500"><th></th><th>Destination Charge</th><th>Destination Charge, manual capture</th><th>Separate Charges and Transfers</th></tr>
          </thead>
          <tbody>
            {line("Płatność (PaymentIntent)", (d) => d.summary.id)}
            {line("Status", (d) => `${STATUS_PL[d.summary.status] ?? d.summary.status}`)}
            {line("Zablokowane na karcie", (d) => pln(readMoney(d).held))}
            {line("Pobrano od klienta", (d) => pln(readMoney(d).captured))}
            {line("Zwrócono klientowi", (d) => pln(readMoney(d).refunded))}
            {line("Przekazano sprzedawcy (brutto)", (d) => pln(readMoney(d).transfersGross))}
            {line("Prowizja platformy", (d) => { const m = readMoney(d); return d.summary.connect.charge_model === "separate" ? `${pln(m.keptBySeparate)} (nieprzekazana część)` : pln(m.commissionGross - m.commissionRefunded); })}
            {line("Opłata Stripe", (d) => pln(readMoney(d).stripeFee))}
            {line("Sprzedawca ma", (d) => { const m = readMoney(d); return `${pln(m.sellerNet)} (oczekujące ${pln(m.sellerPending)})`; })}
            {line("Wynik platformy netto", (d) => pln(readMoney(d).platformNet))}
            {line("Kto decyduje o przelewie", (d) => (d.summary.connect.charge_model === "separate" ? "platforma — osobny przelew" : "Stripe — automatycznie przy pobraniu"))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-zinc-500">Dane z rzeczywistych płatności Stripe Sandbox{fetchedAt ? `, stan z ${dateTime(fetchedAt)}` : ""}. Część kwot Stripe zapisuje z kilkusekundowym opóźnieniem.</p>
      <div className="flex flex-wrap gap-2">
        {(["A", "B", "C"] as const).map((l) => <button key={l} className="btn" onClick={() => ctx.go(l)}>Przejdź do scenariusza {l}</button>)}
      </div>
    </ScenarioIntro>
  );
}

// ---------- Zwrot pieniędzy ----------

export function RefundScenario({ ctx }: { ctx: ScenarioCtx }) {
  const [amount, setAmount] = useState<number | null>(null);
  const [recover, setRecover] = useState(true);
  const [waiveFee, setWaiveFee] = useState(true);
  const d = ctx.details;
  const m = d ? readMoney(d) : null;
  const model = d?.summary.connect.charge_model ?? null;
  const target = d && d.summary.status === "succeeded" ? d : null;
  const letter = d?.summary.booking?.scenario ?? null;
  const refundReason = !target ? "brak pobranej płatności" : m!.refundable <= 0 ? "płatność została już w całości zwrócona" : amount !== null && amount > m!.refundable ? `maksymalnie ${pln(m!.refundable)}` : null;
  return (
    <ScenarioIntro title="Zwrot pieniędzy klientowi">
      <div className="flex flex-wrap items-center gap-2">
        <span>Której płatności dotyczy zwrot?</span>
        {(["A", "B", "C"] as const).map((l) => (
          <button key={l} className={`btn ${letter === l ? "btn-primary" : ""}`} disabled={!ctx.runs[l]} onClick={() => ctx.show(ctx.runs[l]!)}>
            Scenariusz {l}{!ctx.runs[l] && " (nie uruchomiono)"}
          </button>
        ))}
      </div>
      <Explain
        action="Platforma oddaje klientowi całość lub część pobranej kwoty."
        customer="Klient dostaje pieniądze z powrotem (w rzeczywistości bank księguje to kilka dni)."
        seller={model === "destination" ? "Przy podziale płatności (A, B) pieniądze można od razu odzyskać od sprzedawcy." : model === "separate" ? "W scenariuszu C sprzedawca zachowuje przelew, dopóki platforma go nie cofnie." : "Wybierz płatność A, B lub C."}
        platform="Zwrot idzie z konta platformy. Stripe nie oddaje swojej opłaty — platforma traci ją przy pełnym zwrocie."
      />
      {!target ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          {d?.summary.status === "requires_capture" ? "Ta płatność jest tylko blokadą — zamiast zwrotu zwolnij ją w scenariuszu B." : "Wybierz pobraną płatność ze scenariusza A, B lub C (najpierw uruchom scenariusz)."}
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-4">
            <ZlInput key={target.summary.id} label={`Kwota zwrotu (puste = całość, ${pln(m!.refundable)})`} value={amount} onChange={setAmount} />
            {model === "destination" && (
              <div className="text-sm">
                <label className="block"><input type="checkbox" checked={recover} onChange={(e) => setRecover(e.target.checked)} /> odzyskaj tę kwotę od sprzedawcy</label>
                <label className="block"><input type="checkbox" checked={waiveFee} onChange={(e) => setWaiveFee(e.target.checked)} /> platforma oddaje proporcjonalną część prowizji</label>
              </div>
            )}
            <Primary label="Zwróć pieniądze" reason={refundReason} busy={ctx.busy} testId="refund-guided" onClick={() => void refund(ctx, target, amount ?? undefined, recover, waiveFee)} />
          </div>
          {m!.reversibleTransferId && (model === "separate" || m!.refunded > 0) && (
            <div className="flex flex-wrap items-center gap-2">
              <Primary label={`Cofnij przelew od sprzedawcy (${pln(m!.reversibleAmount)})`} reason={null} busy={ctx.busy} testId="reverse-guided" onClick={() => void reverse(ctx, target, m!.reversibleTransferId!)} />
              {model === "separate" && m!.refunded > 0 && <span className="text-amber-700 dark:text-amber-400">Klient dostał zwrot, ale sprzedawca nadal ma przelane pieniądze — cofnij przelew.</span>}
            </div>
          )}
        </div>
      )}
      <Technical>
        <p><code>POST /v1/refunds</code>; w A i B z <code>reverse_transfer</code> i <code>refund_application_fee</code>. W C cofnięcie przelewu to osobne <code>POST /v1/transfers/:id/reversals</code>.</p>
      </Technical>
    </ScenarioIntro>
  );
}

// ---------- Wygaśnięcie blokady ----------

export function ExpiryScenario({ ctx }: { ctx: ScenarioCtx }) {
  const b = runDetails(ctx, "B");
  return (
    <ScenarioIntro title="Co się dzieje, gdy blokada wygaśnie (scenariusz B)">
      <p>Blokada kaucji ze scenariusza B trwa ograniczony czas (w Sandbox: 7 dni). Jeśli platforma jej nie pobierze ani nie zwolni, bank zwalnia ją sam i kaucji nie da się już pobrać.</p>
      {!b && <button className="btn btn-primary" onClick={() => ctx.go("B")}>Najpierw uruchom scenariusz B →</button>}
      <ExpirySimulation details={b} />
    </ScenarioIntro>
  );
}

// ---------- Konta sprzedawców ----------

export function AccountsScenario({ accounts, accountsError, balance, onRefresh }: { accounts: AccountsResponse | null; accountsError: string | null; balance: BalanceResponse | null; onRefresh: () => void }) {
  const lab = accounts?.accounts.find((a) => a.isLabAccount) ?? null;
  return (
    <ScenarioIntro title="Konta sprzedawców">
      <p>Sprzedawca ma w Stripe własne konto (konto połączone), na które platforma przekazuje pieniądze. Laboratorium wysyła pieniądze tylko na jedno, specjalnie oznaczone konto testowe; pozostałe konta są tylko wyświetlane.</p>
      {lab && (
        <ul className="ml-5 list-disc">
          <li>Konto sprzedawcy laboratorium: <b>{lab.id}</b> ({lab.country}, waluta {lab.default_currency?.toUpperCase()})</li>
          <li>Może przyjmować płatności: <b>{lab.charges_enabled ? "tak" : "nie"}</b></li>
          <li>Może otrzymywać wypłaty na konto bankowe: <b>{lab.payouts_enabled ? "tak" : "nie"}</b></li>
          <li>Gotowe do testów: <b>{lab.readiness?.ready ? "tak" : `nie (${lab.readiness?.reasons.join("; ") ?? "?"})`}</b></li>
          {balance && <li>Saldo sprzedawcy: oczekujące {pln(balance.seller.pending)}, dostępne {pln(balance.seller.available)}</li>}
        </ul>
      )}
      <details>
        <summary className="cursor-pointer font-bold">Wszystkie konta i ich uprawnienia (szczegóły techniczne)</summary>
        <div className="mt-2"><AccountsPanel accounts={accounts?.accounts ?? null} accountsError={accountsError} balance={balance} onRefresh={onRefresh} /></div>
      </details>
    </ScenarioIntro>
  );
}
