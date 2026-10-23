"use client";

import { useState } from "react";
import type { TestPaymentMethod } from "@/lib/lab/schemas";
import type { OperationResult } from "@/lib/lab/types";
import { AccountsPanel } from "./accounts-panel";
import type { AccountRow, AccountsResponse, ApiResult, BalanceResponse, PaymentDetails } from "./api";
import { api, newKey, pln } from "./api";
import { ExpirySimulation } from "./expiry-simulation";
import { Explain, ResultCard, ScenarioIntro, Steps, type NextAction } from "./guided";
import type { HistoryEntry } from "./history-panel";
import { readMoney } from "./money";
import { ZlInput } from "./zl-input";

export type TabId = "hold" | "capture" | "split" | "transfer" | "refund" | "expiry" | "accounts";

export const TABS: { id: TabId; label: string }[] = [
  { id: "hold", label: "1. Blokada kaucji" },
  { id: "capture", label: "2. Pobranie kaucji" },
  { id: "split", label: "3. Podział płatności" },
  { id: "transfer", label: "4. Przekazanie pieniędzy" },
  { id: "refund", label: "5. Zwrot pieniędzy" },
  { id: "expiry", label: "6. Wygaśnięcie blokady" },
  { id: "accounts", label: "7. Konta sprzedawców" },
];

type Perform = <T>(label: string, call: () => Promise<ApiResult<T>>) => Promise<ApiResult<T>>;

export type ScenarioCtx = {
  details: PaymentDetails | null;
  busy: boolean;
  labAccount: AccountRow | null;
  maxAmount: number;
  card: TestPaymentMethod;
  perform: Perform;
  show: (id: string) => void;
  go: (tab: TabId) => void;
  clear: () => void;
};

// ---------- actions (all executed by Stripe Sandbox through the lab API) ----------

async function startPayment(
  ctx: ScenarioCtx,
  label: string,
  params: { amount: number; chargeModel: "platform" | "destination" | "separate"; captureMethod: "manual" | "automatic"; applicationFeeAmount?: number; scenario: string },
): Promise<string | null> {
  const created = await ctx.perform<OperationResult>(`${label} — przygotowanie płatności`, () =>
    api("POST", "/api/lab/payment-intents", {
      ...params,
      ...(params.chargeModel !== "platform" && { accountId: ctx.labAccount?.id }),
      idempotencyKey: newKey(),
    }),
  );
  if (!created.ok || !created.body.ok) return null;
  const id = created.body.summary.id;
  ctx.show(id);
  const confirmed = await ctx.perform(`${label} — autoryzacja karty klienta`, () =>
    api("POST", `/api/lab/payment-intents/${id}/confirm`, { paymentMethod: ctx.card, idempotencyKey: newKey() }),
  );
  ctx.show(id);
  return confirmed.ok ? id : null;
}

const capture = (ctx: ScenarioCtx, d: PaymentDetails, amount?: number) => {
  const s = d.summary;
  // A partial capture of a Destination Charge re-sets the commission proportionally.
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

// ---------- shared helpers ----------

function sellerReason(ctx: ScenarioCtx): string | null {
  if (!ctx.labAccount) return "brak konta sprzedawcy laboratorium";
  return ctx.labAccount.readiness?.ready ? null : "konto sprzedawcy laboratorium nie jest gotowe (zakładka 7)";
}

function amountReason(ctx: ScenarioCtx, amount: number | null): string | null {
  if (amount === null) return "podaj poprawną kwotę";
  if (amount > ctx.maxAmount) return `maksymalnie ${pln(ctx.maxAmount)}`;
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

const isFinal = (d: PaymentDetails) => d.summary.status === "succeeded" || d.summary.status === "canceled";
const authorized = (d: PaymentDetails | null) => !!d && ["requires_capture", "succeeded", "canceled"].includes(d.summary.status) && !!d.objects.charge;

/** Next steps offered in the result card, derived from the real state of the payment. */
export function nextActionsFor(ctx: ScenarioCtx): NextAction[] {
  const d = ctx.details;
  if (!d) return [];
  const m = readMoney(d);
  const s = d.summary;
  const out: NextAction[] = [];
  if (s.status === "requires_capture") {
    out.push({ label: "Pobierz kaucję (całość lub część)", onClick: () => ctx.go("capture") });
    out.push({ label: "Zwolnij blokadę", onClick: () => void cancel(ctx, d) });
    out.push({ label: "Zobacz termin wygaśnięcia", onClick: () => ctx.go("expiry") });
  }
  if (m.transferable > 0) out.push({ label: "Przekaż pieniądze sprzedawcy", onClick: () => ctx.go("transfer") });
  if (s.status === "succeeded" && m.refundable > 0) out.push({ label: "Zwróć pieniądze klientowi", onClick: () => ctx.go("refund") });
  if (m.reversibleTransferId && (m.refunded > 0 || s.connect.charge_model === "separate")) {
    out.push({ label: "Cofnij przelew od sprzedawcy", onClick: () => ctx.go("refund") });
  }
  out.push({ label: "Zacznij od nowa", onClick: ctx.clear });
  return out;
}

/** Result card with next steps computed from the scenario context. */
export function ScenarioResult({ ctx, loading, lastEntry }: { ctx: ScenarioCtx; loading: boolean; lastEntry: HistoryEntry | null }) {
  return <ResultCard details={ctx.details} loading={loading} lastEntry={lastEntry} next={nextActionsFor(ctx)} />;
}

// ---------- 1. Blokada kaucji ----------

export function HoldScenario({ ctx }: { ctx: ScenarioCtx }) {
  const [amount, setAmount] = useState<number | null>(5000);
  const d = ctx.details && ctx.details.summary.connect.charge_model === "platform" && ctx.details.summary.capture_method === "manual" ? ctx.details : null;
  const st = d?.summary.status;
  const canStart = !d || isFinal(d);
  return (
    <ScenarioIntro title="Blokada kaucji na karcie klienta">
      <Explain
        action={`Platforma prosi bank klienta o zablokowanie ${amount ? pln(amount) : "kaucji"} na karcie.`}
        customer="Pieniądze zostają na koncie klienta, ale są zablokowane. Nic nie jest jeszcze pobrane."
        seller="Sprzedawca na tym etapie nic nie dostaje."
        platform="Blokada nic nie kosztuje. Opłata Stripe pojawi się dopiero, gdy kaucja zostanie pobrana."
      />
      <Steps
        steps={[
          { title: "Klient podaje kartę płatniczą", text: "W laboratorium używamy testowej karty Visa (do zmiany w trybie zaawansowanym).", done: !!d && st !== "requires_payment_method" },
          { title: `Platforma prosi o blokadę ${amount ? pln(amount) : ""}`, text: "Powstaje płatność z ręcznym pobraniem (autoryzacja bez obciążenia).", done: !!d },
          { title: "Stripe i bank potwierdzają autoryzację", text: "Bank klienta zgadza się zablokować kwotę.", done: authorized(d) },
          { title: "Pieniądze zablokowane, ale nie pobrane", text: "Blokada trwa do 7 dni — potem wygasa sama.", done: authorized(d) },
          { title: "Decyzja: pobrać kaucję czy ją zwolnić", text: "Po najmie: szkoda → pobierz (całość lub część), brak szkody → zwolnij.", done: !!d && isFinal(d) },
          { title: "Wynik", text: "Szczegóły poniżej, w sekcji „Wynik”.", done: !!d && isFinal(d) },
        ]}
      />
      <div className="flex flex-wrap items-end gap-3">
        {canStart && (
          <>
            <ZlInput label="Kwota kaucji" value={amount} onChange={setAmount} help="Domyślnie 50 zł" testId="hold-amount" />
            <Primary label={`Zablokuj kaucję ${amount ? pln(amount) : ""}`} reason={amountReason(ctx, amount)} busy={ctx.busy} testId="hold-start"
              onClick={() => void startPayment(ctx, "Blokada kaucji", { amount: amount!, chargeModel: "platform", captureMethod: "manual", scenario: "ux-hold" })} />
          </>
        )}
        {st === "requires_capture" && (
          <>
            <button className="btn btn-primary" disabled={ctx.busy} onClick={() => ctx.go("capture")}>Pobierz kaucję →</button>
            <button className="btn" disabled={ctx.busy} onClick={() => void cancel(ctx, d!)} data-testid="hold-release">Zwolnij blokadę (brak szkody)</button>
          </>
        )}
      </div>
      <Technical>
        <p>Płatność to <code>PaymentIntent</code> z <code>capture_method: manual</code>, potwierdzony testową kartą. Status <code>requires_capture</code> oznacza aktywną blokadę; termin wygaśnięcia to <code>charge.payment_method_details.card.capture_before</code>.</p>
        <p>Zwolnienie blokady to <code>POST /v1/payment_intents/:id/cancel</code> — nie tworzy żadnych transakcji salda (zweryfikowane w Sandbox).</p>
      </Technical>
    </ScenarioIntro>
  );
}

// ---------- 2. Pobranie kaucji ----------

export function CaptureScenario({ ctx }: { ctx: ScenarioCtx }) {
  const [holdAmount, setHoldAmount] = useState<number | null>(5000);
  const [part, setPart] = useState<number | null>(2000);
  const d = ctx.details;
  const target = d?.summary.status === "requires_capture" ? d : null;
  const isHold = !!d && d.summary.capture_method === "manual";
  const m = d ? readMoney(d) : null;
  const partReason = !target ? "brak aktywnej blokady" : part === null ? "podaj kwotę" : part >= target.summary.amount_capturable ? `część musi być mniejsza niż ${pln(target.summary.amount_capturable)}` : null;
  return (
    <ScenarioIntro title="Pobranie kaucji (np. po szkodzie)">
      <Explain
        action="Platforma pobiera z blokady całą kaucję albo jej część."
        customer="Pobrana kwota schodzi z karty klienta. Reszta blokady jest zwalniana — bez zwrotu i bez kosztów."
        seller={target?.summary.connect.charge_model === "destination" ? "Sprzedawca dostaje pobraną kwotę minus prowizję platformy." : "W zwykłej kaucji platformy sprzedawca nic nie dostaje."}
        platform="Platforma otrzymuje pobraną kwotę i płaci od niej opłatę Stripe."
      />
      <Steps
        steps={[
          { title: "Kaucja zablokowana na karcie", text: "Potrzebna jest aktywna blokada (zakładka 1).", done: isHold && authorized(d) },
          { title: "Pobranie całości lub części", text: "Pobrać można tylko raz.", done: isHold && d!.summary.status === "succeeded" },
          { title: "Reszta blokady wraca do klienta", text: "Niepobrana część jest zwalniana automatycznie.", done: isHold && d!.summary.status === "succeeded" },
          { title: "Wynik", text: "Szczegóły w sekcji „Wynik”.", done: isHold && d!.summary.status === "succeeded" },
        ]}
      />
      {!target ? (
        <div className="flex flex-wrap items-end gap-3">
          <p className="w-full text-zinc-600 dark:text-zinc-400">
            {d && isHold && d.summary.status === "succeeded" ? `Ta kaucja została już pobrana (${pln(m!.captured)}). Drugie pobranie nie jest możliwe.` : "Najpierw potrzebna jest aktywna blokada kaucji."}
          </p>
          <ZlInput label="Kwota nowej kaucji" value={holdAmount} onChange={setHoldAmount} />
          <Primary label={`Zablokuj kaucję ${holdAmount ? pln(holdAmount) : ""}`} reason={amountReason(ctx, holdAmount)} busy={ctx.busy}
            onClick={() => void startPayment(ctx, "Blokada kaucji", { amount: holdAmount!, chargeModel: "platform", captureMethod: "manual", scenario: "ux-capture" })} />
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-4">
          <Primary label={`Pobierz całą kaucję (${pln(target.summary.amount_capturable)})`} reason={null} busy={ctx.busy} testId="capture-full-guided" onClick={() => void capture(ctx, target)} />
          <span className="flex items-end gap-2">
            <ZlInput label="albo pobierz część" value={part} onChange={setPart} help="reszta wróci do klienta" testId="capture-part-amount" />
            <Primary label="Pobierz część" reason={partReason} busy={ctx.busy} testId="capture-part" onClick={() => void capture(ctx, target, part!)} />
          </span>
        </div>
      )}
      <Technical>
        <p><code>POST /v1/payment_intents/:id/capture</code> z opcjonalnym <code>amount_to_capture</code>. Po częściowym pobraniu Stripe zwalnia resztę bez obiektu <code>Refund</code> (<code>amount_refunded</code> = 0) — zweryfikowane w Sandbox.</p>
        <p>Dla podziału płatności prowizja jest ustawiana ponownie, proporcjonalnie do pobranej kwoty (<code>application_fee_amount</code>).</p>
      </Technical>
    </ScenarioIntro>
  );
}

// ---------- 3. Podział płatności ----------

export function SplitScenario({ ctx }: { ctx: ScenarioCtx }) {
  const [amount, setAmount] = useState<number | null>(5000);
  const [percent, setPercent] = useState("10");
  const [hold, setHold] = useState(false);
  const pct = Number(percent.replace(",", "."));
  const pctValid = Number.isFinite(pct) && pct >= 0 && pct < 100;
  const fee = amount !== null && pctValid ? Math.round((amount * pct) / 100) : null;
  const d = ctx.details?.summary.connect.charge_model === "destination" ? ctx.details : null;
  const m = d ? readMoney(d) : null;
  const reason = amountReason(ctx, amount) ?? (!pctValid ? "prowizja musi być od 0 do 99%" : null) ?? sellerReason(ctx);
  return (
    <ScenarioIntro title="Podział płatności między sprzedawcę a platformę">
      <Explain
        action={`Klient płaci ${amount ? pln(amount) : "kwotę"}; Stripe od razu dzieli ją między sprzedawcę i platformę.`}
        customer={`Klient płaci ${amount ? pln(amount) : "kwotę"} (od razu albo po blokadzie).`}
        seller={fee !== null && amount !== null ? `Sprzedawca dostaje ${pln(amount - fee)}.` : "Sprzedawca dostaje kwotę minus prowizję."}
        platform={fee !== null ? `Platforma zatrzymuje prowizję ${pln(fee)} i płaci z niej opłatę Stripe (pokażemy rzeczywistą).` : "Platforma zatrzymuje prowizję i płaci opłatę Stripe."}
      />
      <Steps
        steps={[
          { title: "Klient płaci", text: "Płatność trafia na konto platformy.", done: !!d && (d.summary.status === "succeeded" || d.summary.status === "requires_capture") },
          { title: "Stripe przekazuje pieniądze sprzedawcy", text: "Automatycznie, w chwili pobrania płatności.", done: !!m && m.transfersGross > 0 },
          { title: "Prowizja wraca do platformy", text: "Stripe tworzy ją kilka sekund później.", done: !!m && m.commissionGross > 0 },
          { title: "Stripe pobiera swoją opłatę od platformy", text: "Opłata obciąża platformę, nie sprzedawcę.", done: !!m && m.stripeFee > 0 },
          { title: "Wynik", text: "Rozliczenie w sekcji „Wynik”.", done: !!m && m.commissionGross > 0 },
        ]}
      />
      {d?.summary.status === "requires_capture" && <p className="text-amber-700 dark:text-amber-400">Płatność jest na razie blokadą — pobierz ją w zakładce 2, wtedy nastąpi podział.</p>}
      <div className="flex flex-wrap items-end gap-4">
        <ZlInput label="Kwota płatności" value={amount} onChange={setAmount} />
        <label className="block">
          <span className="font-bold">Prowizja platformy</span>
          <span className="mt-1 flex items-center gap-1">
            <input value={percent} onChange={(e) => setPercent(e.target.value)} inputMode="decimal" className="w-16 rounded border px-2 py-1 text-right" />%
          </span>
          <span className="text-xs text-zinc-500">{fee !== null ? `= ${pln(fee)}` : "podaj procent"}</span>
        </label>
        <label className="block text-sm">
          <input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} /> najpierw tylko zablokuj (kaucja)
        </label>
        <Primary label={`Klient płaci ${amount ? pln(amount) : ""}`} reason={reason} busy={ctx.busy} testId="split-start"
          onClick={() => void startPayment(ctx, "Płatność z podziałem", { amount: amount!, chargeModel: "destination", captureMethod: hold ? "manual" : "automatic", applicationFeeAmount: fee!, scenario: "ux-split" })} />
      </div>
      <Technical>
        <p>To model <b>Destination Charge</b>: <code>transfer_data.destination</code> = konto sprzedawcy laboratorium i <code>application_fee_amount</code> = prowizja. Obciążenie powstaje na platformie; Stripe przelewa sprzedawcy całą kwotę, a obiekt <code>Application Fee</code> zwraca prowizję platformie.</p>
        <p>Platforma płaci opłatę Stripe i odpowiada za zwroty i spory (zweryfikowane: opłata; spory wg dokumentacji).</p>
      </Technical>
    </ScenarioIntro>
  );
}

// ---------- 4. Przekazanie pieniędzy ----------

export function TransferScenario({ ctx }: { ctx: ScenarioCtx }) {
  const [amount, setAmount] = useState<number | null>(5000);
  const [toSeller, setToSeller] = useState<number | null>(4500);
  const d = ctx.details?.summary.connect.charge_model === "separate" ? ctx.details : null;
  const m = d ? readMoney(d) : null;
  const paid = d?.summary.status === "succeeded";
  const transferReason = !d || !paid ? "najpierw klient musi zapłacić" : toSeller === null ? "podaj kwotę" : m!.transferable <= 0 ? "nie ma już środków z tej płatności do przekazania" : toSeller > m!.transferable ? `maksymalnie ${pln(m!.transferable)}` : sellerReason(ctx);
  return (
    <ScenarioIntro title="Przekazanie pieniędzy sprzedawcy później">
      <Explain
        action="Klient płaci platformie, a platforma sama decyduje, kiedy i ile przekazać sprzedawcy (np. po zakończeniu najmu)."
        customer={`Klient płaci ${amount ? pln(amount) : "kwotę"} od razu.`}
        seller={`Sprzedawca dostaje pieniądze dopiero po przelewie platformy${toSeller ? ` (tu: ${pln(toSeller)})` : ""}.`}
        platform="Platforma trzyma pieniądze do czasu przelewu, zatrzymuje różnicę i płaci opłatę Stripe."
      />
      <Steps
        steps={[
          { title: "Klient płaci platformie", text: "Pieniądze trafiają tylko na konto platformy.", done: !!paid },
          { title: "Pieniądze czekają na platformie", text: "Sprzedawca jeszcze nic nie ma.", done: !!paid },
          { title: "Platforma przekazuje pieniądze sprzedawcy", text: "Osobny przelew — dowolna kwota do wysokości płatności.", done: !!m && m.transfersGross > 0 },
          { title: "Wynik", text: "Rozliczenie w sekcji „Wynik”.", done: !!m && m.transfersGross > 0 },
        ]}
      />
      <div className="flex flex-wrap items-end gap-4">
        <ZlInput label="Klient płaci" value={amount} onChange={setAmount} />
        <Primary label={`Klient płaci platformie ${amount ? pln(amount) : ""}`} reason={amountReason(ctx, amount) ?? sellerReason(ctx)} busy={ctx.busy} testId="transfer-pay"
          onClick={() => void startPayment(ctx, "Płatność na platformę", { amount: amount!, chargeModel: "separate", captureMethod: "automatic", scenario: "ux-transfer" })} />
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <ZlInput label="Przekaż sprzedawcy" value={toSeller} onChange={setToSeller} help={m && paid ? `do przekazania: ${pln(Math.max(m.transferable, 0))}` : undefined} />
        <Primary label={`Przekaż sprzedawcy ${toSeller ? pln(toSeller) : ""}`} reason={transferReason} busy={ctx.busy} testId="transfer-send" onClick={() => void transfer(ctx, d!, toSeller!)} />
      </div>
      <Technical>
        <p>To model <b>Separate Charges and Transfers</b>: obciążenie na platformie z <code>transfer_group</code>, potem <code>POST /v1/transfers</code> z <code>source_transaction</code> (przelew finansowany z tej płatności, nie z wolnego salda platformy).</p>
        <p>Brak obiektu prowizji — zarobek platformy to część nieprzekazana sprzedawcy.</p>
      </Technical>
    </ScenarioIntro>
  );
}

// ---------- 5. Zwrot pieniędzy ----------

export function RefundScenario({ ctx }: { ctx: ScenarioCtx }) {
  const [amount, setAmount] = useState<number | null>(null);
  const [recover, setRecover] = useState(true);
  const [waiveFee, setWaiveFee] = useState(true);
  const d = ctx.details;
  const m = d ? readMoney(d) : null;
  const model = d?.summary.connect.charge_model ?? null;
  const target = d && d.summary.status === "succeeded" ? d : null;
  const refundReason = !target ? "brak pobranej płatności" : m!.refundable <= 0 ? "płatność została już w całości zwrócona" : amount !== null && amount > m!.refundable ? `maksymalnie ${pln(m!.refundable)}` : null;

  const example = async (kind: "split" | "transfer" | "plain") => {
    if (kind === "split") return startPayment(ctx, "Przykład: płatność z podziałem", { amount: 5000, chargeModel: "destination", captureMethod: "automatic", applicationFeeAmount: 500, scenario: "ux-refund" });
    if (kind === "plain") return startPayment(ctx, "Przykład: zwykła płatność", { amount: 5000, chargeModel: "platform", captureMethod: "automatic", scenario: "ux-refund" });
    const id = await startPayment(ctx, "Przykład: płatność na platformę", { amount: 5000, chargeModel: "separate", captureMethod: "automatic", scenario: "ux-refund" });
    if (id) {
      await ctx.perform("Przykład: przelew 45,00 zł do sprzedawcy", () => api("POST", "/api/lab/transfers", { paymentIntentId: id, amount: 4500, idempotencyKey: newKey() }));
      ctx.show(id);
    }
    return id;
  };

  return (
    <ScenarioIntro title="Zwrot pieniędzy klientowi">
      <Explain
        action="Platforma oddaje klientowi całość lub część pobranej kwoty."
        customer="Klient dostaje pieniądze z powrotem (w rzeczywistości bank księguje to kilka dni)."
        seller={model === "destination" ? "Przy podziale płatności pieniądze można od razu odzyskać od sprzedawcy." : model === "separate" ? "Przy osobnym przelewie sprzedawca zachowuje pieniądze, dopóki platforma nie cofnie przelewu." : "Sprzedawca nie uczestniczy."}
        platform="Zwrot idzie z konta platformy. Stripe nie oddaje swojej opłaty — platforma traci ją przy pełnym zwrocie."
      />
      <Steps
        steps={[
          { title: "Płatność pobrana od klienta", text: "Zwrot wymaga pobranej płatności (blokadę się zwalnia, nie zwraca).", done: !!m && m.captured > 0 },
          { title: "Zwrot dla klienta", text: "Pieniądze wracają z konta platformy.", done: !!m && m.refunded > 0 },
          ...(model === "platform" ? [] : [{ title: "Odzyskanie pieniędzy od sprzedawcy", text: model === "destination" ? "W tym samym kroku co zwrot." : "Osobne cofnięcie przelewu.", done: !!m && m.reversals > 0 }]),
          { title: "Wynik", text: "Rozliczenie w sekcji „Wynik”.", done: !!m && m.refunded > 0 && (model === "platform" || m.reversals > 0 || m.transfersGross === 0) },
        ]}
      />
      {!target ? (
        <div className="space-y-2">
          <p className="text-zinc-600 dark:text-zinc-400">
            {d?.summary.status === "requires_capture" ? "Ta płatność jest tylko blokadą — zamiast zwrotu zwolnij ją w zakładce 1." : "Brak pobranej płatności. Utwórz przykładową:"}
          </p>
          <div className="flex flex-wrap gap-2">
            <Primary label="Płatność z podziałem 50 zł (prowizja 10%)" reason={sellerReason(ctx)} busy={ctx.busy} onClick={() => void example("split")} />
            <Primary label="Płatność 50 zł + przelew 45 zł do sprzedawcy" reason={sellerReason(ctx)} busy={ctx.busy} onClick={() => void example("transfer")} />
            <Primary label="Zwykła płatność 50 zł na platformę" reason={null} busy={ctx.busy} onClick={() => void example("plain")} />
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-4">
            <ZlInput label={`Kwota zwrotu (puste = całość, ${pln(m!.refundable)})`} value={amount} onChange={setAmount} />
            {model === "destination" && (
              <div className="text-sm">
                <label className="block"><input type="checkbox" checked={recover} onChange={(e) => setRecover(e.target.checked)} /> odzyskaj tę kwotę od sprzedawcy</label>
                <label className="block"><input type="checkbox" checked={waiveFee} onChange={(e) => setWaiveFee(e.target.checked)} /> platforma oddaje proporcjonalną część prowizji</label>
              </div>
            )}
            <Primary label="Zwróć pieniądze" reason={refundReason} busy={ctx.busy} testId="refund-guided" onClick={() => void refund(ctx, target, amount ?? undefined, recover, waiveFee)} />
          </div>
          {m!.reversibleTransferId && (
            <div className="flex flex-wrap items-center gap-2">
              <Primary label={`Cofnij przelew od sprzedawcy (${pln(m!.reversibleAmount)})`} reason={null} busy={ctx.busy} testId="reverse-guided" onClick={() => void reverse(ctx, target, m!.reversibleTransferId!)} />
              {model === "separate" && m!.refunded > 0 && <span className="text-amber-700 dark:text-amber-400">Klient dostał zwrot, ale sprzedawca nadal ma przelane pieniądze — cofnij przelew.</span>}
            </div>
          )}
        </div>
      )}
      <Technical>
        <p><code>POST /v1/refunds</code>; przy Destination Charge z <code>reverse_transfer</code> (odzyskanie od sprzedawcy) i <code>refund_application_fee</code> (zwrot prowizji). Przy Separate Charges cofnięcie to osobne <code>POST /v1/transfers/:id/reversals</code>.</p>
        <p>Zweryfikowane w Sandbox: opłata Stripe nie jest zwracana; po pełnym zwrocie platforma ma −2,63 zł na każde 50 zł.</p>
      </Technical>
    </ScenarioIntro>
  );
}

// ---------- 6. Wygaśnięcie blokady ----------

export function ExpiryScenario({ ctx }: { ctx: ScenarioCtx }) {
  const hasHold = ctx.details?.summary.status === "requires_capture";
  return (
    <ScenarioIntro title="Co się dzieje, gdy blokada wygaśnie">
      <p>Blokada kaucji na karcie trwa ograniczony czas (w Sandbox: 7 dni). Jeśli platforma jej nie pobierze ani nie zwolni, bank zwalnia ją sam i kaucji nie da się już pobrać.</p>
      {!hasHold && (
        <Primary label="Zablokuj kaucję 50 zł, aby zobaczyć termin" reason={null} busy={ctx.busy}
          onClick={() => void startPayment(ctx, "Blokada kaucji", { amount: 5000, chargeModel: "platform", captureMethod: "manual", scenario: "ux-expiry" })} />
      )}
      <ExpirySimulation details={ctx.details} />
    </ScenarioIntro>
  );
}

// ---------- 7. Konta sprzedawców ----------

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
