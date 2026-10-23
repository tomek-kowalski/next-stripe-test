"use client";

import { useState } from "react";
import type { OperationResult } from "@/lib/lab/types";
import type { AccountRow, ApiResult, PaymentDetails } from "./api";
import { api, MODEL_PL, newKey, pln } from "./api";

export type Model = "platform" | "destination" | "separate";
type Perform = <T>(label: string, call: () => Promise<ApiResult<T>>) => Promise<ApiResult<T>>;

type Props = {
  model: Model;
  labAccount: AccountRow | null;
  details: PaymentDetails | null;
  busy: boolean;
  perform: Perform;
  onPaymentIntent: (id: string) => void;
};

const CANCELABLE = ["requires_payment_method", "requires_confirmation", "requires_action", "requires_capture"];

function Action({ label, reason, onClick, busy, testId }: { label: string; reason: string | null; onClick: () => void; busy: boolean; testId: string }) {
  return (
    <div>
      <button className="btn w-full" disabled={busy || reason !== null} onClick={onClick} data-testid={testId}>{label}</button>
      {reason && <div className="mt-0.5 text-xs text-zinc-500" data-testid={`${testId}-reason`}>Niedostępne: {reason}</div>}
    </div>
  );
}

function AmountInput({ label, value, onChange, placeholder }: { label: string; value: number | ""; onChange: (v: number | "") => void; placeholder?: string }) {
  return (
    <label className="block">
      {label}
      <input
        type="number" min={1} step={1} value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
        className="mt-1 w-full rounded border px-2 py-1"
      />
      <span className="text-xs text-zinc-500">{value === "" ? (placeholder ?? "") : pln(value)}</span>
    </label>
  );
}

const validAmount = (v: number | "") => v !== "" && Number.isInteger(v) && v >= 1;

export function PaymentWorkspace({ model, labAccount, details, busy, perform, onPaymentIntent }: Props) {
  const [amount, setAmount] = useState<number | "">(5000);
  const [fee, setFee] = useState<number | "">(500);
  const [captureMethod, setCaptureMethod] = useState<"manual" | "automatic">(model === "separate" ? "automatic" : "manual");
  const [partial, setPartial] = useState<number | "">(3000);
  const [refundAmount, setRefundAmount] = useState<number | "">("");
  const [reverseTransfer, setReverseTransfer] = useState(true);
  const [refundFee, setRefundFee] = useState(true);
  const [transferAmount, setTransferAmount] = useState<number | "">(4500);
  const [reversalAmount, setReversalAmount] = useState<number | "">("");
  const [feeRefundAmount, setFeeRefundAmount] = useState<number | "">("");

  // ---- new payment
  const needsAccount = model !== "platform";
  const accountReason = !needsAccount
    ? null
    : !labAccount
      ? "brak konta laboratorium (metadata.lab) — patrz zakładka „Konta połączone”"
      : labAccount.readiness?.ready
        ? null
        : `konto laboratorium nie jest gotowe (${labAccount.readiness?.reasons.join("; ") ?? "nie sprawdzono"})`;
  const authorizeReason =
    !validAmount(amount) ? "podaj kwotę w groszach (liczba całkowita > 0)"
    : model === "destination" && (fee === "" || !Number.isInteger(fee) || fee < 0 || fee >= (amount as number)) ? "prowizja musi być liczbą całkowitą ≥ 0 i mniejszą od kwoty"
    : accountReason;

  async function authorize() {
    const created = await perform<OperationResult>("Utwórz PaymentIntent", () =>
      api("POST", "/api/lab/payment-intents", {
        amount,
        chargeModel: model,
        captureMethod,
        scenario: `dashboard-${model}`,
        ...(needsAccount && { accountId: labAccount!.id }),
        ...(model === "destination" && { applicationFeeAmount: fee }),
        idempotencyKey: newKey(),
      }),
    );
    if (!created.ok || !created.body.ok) return;
    const id = created.body.summary.id;
    onPaymentIntent(id);
    await perform("Autoryzuj kartą pm_card_visa", () =>
      api("POST", `/api/lab/payment-intents/${id}/confirm`, { paymentMethod: "pm_card_visa", idempotencyKey: newKey() }),
    );
    onPaymentIntent(id);
  }

  // ---- state of the loaded payment (always taken from Stripe)
  const s = details?.summary ?? null;
  const o = details?.objects ?? null;
  const loadedModel = s?.connect.charge_model ?? null;
  const status = s?.status ?? null;
  const noPayment = "najpierw autoryzuj płatność lub wczytaj PaymentIntent";
  const refundable = o?.charge ? o.charge.amount_captured - o.charge.amount_refunded : 0;
  const transferredNet = (o?.transfers ?? []).reduce((n, t) => n + t.amount - t.amount_reversed, 0);
  const transferable = refundable - transferredNet;
  const reversible = (o?.transfers ?? []).find((t) => t.amount - t.amount_reversed > 0) ?? null;
  const appFee = o?.applicationFee ?? null;
  const feeRemaining = appFee ? appFee.amount - appFee.amount_refunded : 0;
  const proportionalFee =
    s && loadedModel === "destination" && s.connect.application_fee_amount !== null && validAmount(partial)
      ? Math.round((s.connect.application_fee_amount * (partial as number)) / s.amount)
      : undefined;

  const captureReason = !s ? noPayment : status !== "requires_capture" ? `wymaga statusu requires_capture (obecnie: ${status})` : null;
  const partialReason =
    captureReason ?? (!validAmount(partial) ? "podaj kwotę częściową" : (partial as number) >= s!.amount_capturable ? `kwota częściowa musi być mniejsza od amount_capturable (${pln(s!.amount_capturable)})` : null);
  const cancelReason = !s ? noPayment : !CANCELABLE.includes(status!) ? `anulować można tylko przed przechwyceniem (obecnie: ${status}); po przechwyceniu użyj zwrotu` : null;
  const refundReason =
    !s ? noPayment
    : status !== "succeeded" ? `zwrot wymaga przechwyconej płatności (obecnie: ${status}); autoryzację anuluj`
    : refundable <= 0 ? "płatność została już w całości zwrócona"
    : refundAmount !== "" && (!validAmount(refundAmount) || (refundAmount as number) > refundable) ? `kwota zwrotu musi być od 1 do ${refundable} gr`
    : null;
  const transferReason =
    !s ? noPayment
    : loadedModel !== "separate" ? (loadedModel === "destination" ? "w Destination Charge przelew tworzy Stripe automatycznie przy przechwyceniu" : "płatność platformowa nie ma sprzedawcy")
    : status !== "succeeded" ? `przelew wymaga przechwyconej płatności (obecnie: ${status})`
    : transferable <= 0 ? "brak środków z tej płatności do przekazania (zwrócone lub już przekazane)"
    : !validAmount(transferAmount) || (transferAmount as number) > transferable ? `kwota przelewu musi być od 1 do ${transferable} gr`
    : accountReason;
  const reversalReason =
    !s ? noPayment
    : !reversible ? (o?.transfers.length ? "wszystkie przelewy zostały w całości cofnięte" : "brak przelewu do cofnięcia")
    : reversalAmount !== "" && (!validAmount(reversalAmount) || (reversalAmount as number) > reversible.amount - reversible.amount_reversed) ? `kwota cofnięcia musi być od 1 do ${reversible.amount - reversible.amount_reversed} gr`
    : null;
  const feeRefundReason =
    !s ? noPayment
    : loadedModel !== "destination" ? "prowizja application fee istnieje tylko w Destination Charge"
    : !appFee ? "prowizja powstaje dopiero przy przechwyceniu (odśwież po chwili, jest tworzona asynchronicznie)"
    : feeRemaining <= 0 ? "prowizja została już w całości zwrócona"
    : feeRefundAmount !== "" && (!validAmount(feeRefundAmount) || (feeRefundAmount as number) > feeRemaining) ? `kwota musi być od 1 do ${feeRemaining} gr`
    : null;

  const refresh = (id: string) => onPaymentIntent(id);

  return (
    <section className="panel space-y-3" data-testid="workspace">
      <h2 className="font-bold">{MODEL_PL[model]} — nowa płatność</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <AmountInput label="Kwota (grosze)" value={amount} onChange={setAmount} />
        {model === "destination" && <AmountInput label="Prowizja platformy application_fee_amount (grosze)" value={fee} onChange={setFee} />}
        <label className="block">
          Przechwycenie
          <select value={captureMethod} onChange={(e) => setCaptureMethod(e.target.value as "manual" | "automatic")} className="mt-1 w-full rounded border px-2 py-1">
            <option value="manual">manual — autoryzacja (kaucja), przechwycenie później</option>
            <option value="automatic">automatic — natychmiastowe obciążenie</option>
          </select>
        </label>
        <div className="text-xs text-zinc-500">
          Waluta: <b>PLN</b> (stała) · karta testowa <code>pm_card_visa</code>
          {needsAccount && <> · sprzedawca: <b>{labAccount?.id ?? "—"}</b></>}
        </div>
      </div>
      <div className="max-w-sm">
        <Action label="Autoryzuj płatność (utwórz + potwierdź)" reason={authorizeReason} onClick={authorize} busy={busy} testId="authorize" />
      </div>

      <h3 className="border-t border-zinc-300 pt-2 font-bold dark:border-zinc-700">
        Operacje na wczytanej płatności {s ? <span className="font-normal">({s.id}, {MODEL_PL[loadedModel!]}, status <code>{status}</code>)</span> : ""}
      </h3>
      {s && loadedModel !== model && (
        <p className="text-xs text-amber-600">Wczytana płatność ma model „{MODEL_PL[loadedModel!]}” — operacje działają według jej rzeczywistego modelu w Stripe.</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="space-y-2">
          <Action label={`Przechwyć całość${s ? ` (${pln(s.amount_capturable)})` : ""}`} reason={captureReason} busy={busy} testId="capture-full"
            onClick={() => perform("Przechwyć całość", () => api("POST", `/api/lab/payment-intents/${s!.id}/capture`, { idempotencyKey: newKey() })).then(() => refresh(s!.id))} />
          <AmountInput label="Kwota częściowa (grosze)" value={partial} onChange={setPartial} />
          <Action label={`Przechwyć częściowo${proportionalFee !== undefined ? ` (prowizja ${pln(proportionalFee)})` : ""}`} reason={partialReason} busy={busy} testId="capture-partial"
            onClick={() => perform(`Przechwyć częściowo ${partial}`, () => api("POST", `/api/lab/payment-intents/${s!.id}/capture`, {
              amountToCapture: partial, ...(proportionalFee !== undefined && { applicationFeeAmount: proportionalFee }), idempotencyKey: newKey(),
            })).then(() => refresh(s!.id))} />
          {proportionalFee !== undefined && <p className="text-xs text-zinc-500">Przy częściowym przechwyceniu prowizja jest ustawiana ponownie, proporcjonalnie do kwoty.</p>}
          <Action label="Anuluj autoryzację" reason={cancelReason} busy={busy} testId="cancel"
            onClick={() => perform("Anuluj autoryzację", () => api("POST", `/api/lab/payment-intents/${s!.id}/cancel`, { cancellationReason: "requested_by_customer", idempotencyKey: newKey() })).then(() => refresh(s!.id))} />
        </div>

        <div className="space-y-2">
          <AmountInput label="Kwota zwrotu (puste = całość możliwa do zwrotu)" value={refundAmount} onChange={setRefundAmount} placeholder={s ? `całość: ${pln(refundable)}` : ""} />
          {loadedModel === "destination" && (
            <div className="text-xs">
              <label className="block"><input type="checkbox" checked={reverseTransfer} onChange={(e) => setReverseTransfer(e.target.checked)} /> <code>reverse_transfer</code> — odzyskaj środki od sprzedawcy</label>
              <label className="block"><input type="checkbox" checked={refundFee} onChange={(e) => setRefundFee(e.target.checked)} /> <code>refund_application_fee</code> — zwróć proporcjonalnie prowizję</label>
            </div>
          )}
          <Action label="Zwrot (Refund)" reason={refundReason} busy={busy} testId="refund"
            onClick={() => perform("Zwrot", () => api("POST", `/api/lab/payment-intents/${s!.id}/refund`, {
              ...(refundAmount !== "" && { amount: refundAmount }),
              ...(loadedModel === "destination" && { reverseTransfer, refundApplicationFee: refundFee }),
              idempotencyKey: newKey(),
            })).then(() => refresh(s!.id))} />
          {loadedModel === "separate" && <p className="text-xs text-zinc-500">W tym modelu zwrot nie cofa przelewu — sprzedawca zachowuje środki, dopóki nie cofniesz przelewu.</p>}
        </div>

        <div className="space-y-2">
          <AmountInput label="Kwota przelewu do sprzedawcy (grosze)" value={transferAmount} onChange={setTransferAmount} />
          <Action label="Przelew (Transfer)" reason={transferReason} busy={busy} testId="transfer"
            onClick={() => perform(`Przelew ${transferAmount}`, () => api("POST", "/api/lab/transfers", { paymentIntentId: s!.id, amount: transferAmount, idempotencyKey: newKey() })).then(() => refresh(s!.id))} />
          {s && loadedModel === "separate" && <p className="text-xs text-zinc-500">Do przekazania z tej płatności: {pln(Math.max(transferable, 0))}</p>}
        </div>

        <div className="space-y-2">
          <AmountInput label="Kwota cofnięcia przelewu (puste = reszta)" value={reversalAmount} onChange={setReversalAmount} placeholder={reversible ? `reszta: ${pln(reversible.amount - reversible.amount_reversed)}` : ""} />
          <Action label={`Cofnij przelew${reversible ? ` ${reversible.id.slice(0, 12)}…` : ""}`} reason={reversalReason} busy={busy} testId="reverse"
            onClick={() => perform("Cofnij przelew", () => api("POST", `/api/lab/transfers/${reversible!.id}/reversals`, { ...(reversalAmount !== "" && { amount: reversalAmount }), idempotencyKey: newKey() })).then(() => refresh(s!.id))} />
          <AmountInput label="Zwrot prowizji do sprzedawcy (puste = reszta)" value={feeRefundAmount} onChange={setFeeRefundAmount} placeholder={appFee ? `reszta: ${pln(feeRemaining)}` : ""} />
          <Action label="Zwróć prowizję (Application Fee Refund)" reason={feeRefundReason} busy={busy} testId="fee-refund"
            onClick={() => perform("Zwrot prowizji", () => api("POST", `/api/lab/application-fees/${appFee!.id}/refunds`, { ...(feeRefundAmount !== "" && { amount: feeRefundAmount }), idempotencyKey: newKey() })).then(() => refresh(s!.id))} />
        </div>
      </div>
      <p className="text-xs text-zinc-500">
        Przyciski są włączane na podstawie stanu pobranego ze Stripe; serwer i tak ponownie sprawdza własność obiektu, konto
        sprzedawcy, stan i kwoty przed każdą operacją. Przelewy i prowizje Destination Charge powstają asynchronicznie — po
        operacji szczegóły odświeżają się automatycznie.
      </p>
    </section>
  );
}
