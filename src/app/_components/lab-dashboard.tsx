"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ScenarioLetter, TestPaymentMethod } from "@/lib/lab/schemas";
import type { LabConfig } from "@/lib/lab/types";
import type { AccountsResponse, ApiError, ApiResult, BalanceResponse, PaymentDetails } from "./api";
import { api, errorText, STATUS_PL } from "./api";
import { ArchitecturePanel } from "./architecture-panel";
import { HistoryPanel, type HistoryEntry } from "./history-panel";
import { PaymentWorkspace, type Model } from "./payment-workspace";
import {
  AccountsScenario,
  BookingPanel,
  ComparePanel,
  ExpiryScenario,
  RefundScenario,
  ScenarioA,
  ScenarioB,
  ScenarioC,
  ScenarioResult,
  TABS,
  type BookingDraft,
  type Runs,
  type ScenarioCtx,
  type TabId,
} from "./scenarios";

const PI_RE = /^pi_[A-Za-z0-9]+$/;
const DEFAULT_MAX_AMOUNT = 1_000_000;
let nextHistoryId = 1;
const INITIAL_BOOKING: BookingDraft = { id: null, item: "", customer: "", start: "", end: "", amount: 10_000, feePercent: "10" };

type AccountsData = { accounts: AccountsResponse | null; error: string | null; balance: BalanceResponse | null };

async function fetchAccountsData(): Promise<AccountsData> {
  const r = await api<AccountsResponse>("GET", "/api/lab/connect/accounts");
  if (!r.ok) return { accounts: null, error: errorText(r), balance: null };
  const lab = r.body.accounts.find((a) => a.isLabAccount);
  const b = lab ? await api<BalanceResponse>("GET", `/api/lab/connect/accounts/${lab.id}/balance`) : null;
  return { accounts: r.body, error: null, balance: b?.ok ? b.body : null };
}

/** The lab API answers 404 "forbidden" outside local development; explain that instead of a raw error. */
function availabilityHint(r: { httpStatus: number; body: ApiError }) {
  return r.httpStatus === 404 && r.body.kind === "forbidden"
    ? "Laboratorium jest wyłączone w tym środowisku. Działa lokalnie (npm run dev) albo na Vercel w trybie testów publicznych — chyba że ustawiono LAB_PUBLIC_ACCESS=0."
    : null;
}

export function LabDashboard() {
  const [tab, setTab] = useState<TabId>("booking");
  const [booking, setBooking] = useState<BookingDraft>(INITIAL_BOOKING);
  const [runs, setRuns] = useState<Runs>({});
  const [config, setConfig] = useState<LabConfig | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<AccountsResponse | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [balance, setBalance] = useState<BalanceResponse | null>(null);
  const [details, setDetails] = useState<PaymentDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [lookupId, setLookupId] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [selected, setSelected] = useState<HistoryEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [card, setCard] = useState<TestPaymentMethod>("pm_card_visa");
  const [advancedModel, setAdvancedModel] = useState<Model>("platform");
  const currentId = useRef<string | null>(null);
  const refreshTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const labAccount = accounts?.accounts.find((a) => a.isLabAccount) ?? null;
  const maxAmount = config?.ok && "maxAmount" in config && typeof config.maxAmount === "number" ? config.maxAmount : DEFAULT_MAX_AMOUNT;

  const applyAccounts = useCallback((d: AccountsData) => {
    if (d.accounts) setAccounts(d.accounts);
    setAccountsError(d.error);
    if (d.balance) setBalance(d.balance);
  }, []);
  const loadAccounts = useCallback(() => fetchAccountsData().then(applyAccounts), [applyAccounts]);

  const loadDetails = useCallback(async (id: string) => {
    currentId.current = id;
    setDetailsLoading(true);
    const r = await api<PaymentDetails>("GET", `/api/lab/payment-intents/${id}/details`);
    if (currentId.current !== id) return;
    setDetailsLoading(false);
    if (r.ok) setDetails(r.body);
    else setUnavailable(availabilityHint(r) ?? `Nie można wczytać ${id}: ${errorText(r)}`);
  }, []);

  /** Stripe creates transfers, fees and balance transactions asynchronously: re-read a few times. */
  const show = useCallback(
    (id: string) => {
      refreshTimers.current.forEach(clearTimeout);
      void loadDetails(id);
      refreshTimers.current = [2500, 6000, 12000].map((ms) => setTimeout(() => void loadDetails(id), ms));
    },
    [loadDetails],
  );

  const clear = useCallback(() => {
    refreshTimers.current.forEach(clearTimeout);
    currentId.current = null;
    setDetails(null);
  }, []);

  useEffect(() => {
    void api<LabConfig>("GET", "/api/lab/config").then((r) => {
      setConfig(r.ok ? r.body : { ok: false, message: errorText(r), apiVersion: "?", sdkVersion: "?" });
      if (!r.ok) setUnavailable(availabilityHint(r));
    });
    void fetchAccountsData().then(applyAccounts);
    const timers = refreshTimers.current;
    return () => timers.forEach(clearTimeout);
  }, [applyAccounts]);

  const perform = useCallback(async <T,>(label: string, call: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> => {
    setBusy(true);
    const r = await call();
    setBusy(false);
    const b = r.body as Record<string, unknown>;
    const summary = b.summary as { status?: string; id?: string } | undefined;
    const hint = r.ok ? null : availabilityHint({ httpStatus: r.httpStatus, body: r.body as ApiError });
    if (hint) setUnavailable(hint);
    const entry: HistoryEntry = {
      id: nextHistoryId++,
      at: new Date().toLocaleTimeString("pl-PL"),
      label,
      operation: (b.operation as string | undefined) ?? null,
      httpStatus: r.httpStatus,
      ok: r.ok,
      message: r.ok
        ? `${label}: OK${summary?.status ? ` → ${STATUS_PL[summary.status] ?? summary.status}` : ""}`
        : `${label}: ${hint ?? errorText({ httpStatus: r.httpStatus, body: r.body as ApiError })}`,
      requestId: (b.requestId as string | null | undefined) ?? null,
      idempotencyKey: (b.idempotencyKey as string | null | undefined) ?? null,
      objectId: (b.objectId as string | undefined) ?? summary?.id ?? null,
      raw: b.raw ?? b,
    };
    setHistory((h) => [entry, ...h]);
    setSelected(entry);
    if (r.ok) void loadAccounts();
    return r;
  }, [loadAccounts]);

  const setRun = useCallback((letter: ScenarioLetter, id: string | null) => {
    setRuns((r) => {
      const next = { ...r };
      if (id) next[letter] = id;
      else delete next[letter];
      return next;
    });
  }, []);

  /** Switching to a scenario tab shows that scenario's own payment for the current booking. */
  const go = (next: TabId) => {
    setTab(next);
    const letter = next === "expiry" ? "B" : next === "A" || next === "B" || next === "C" ? next : null;
    if (!letter) return;
    const id = runs[letter];
    if (id) show(id);
    else if (next !== "expiry") clear();
  };

  const ctx: ScenarioCtx = { details, busy, labAccount, maxAmount, card, booking, setBooking, runs, setRun, perform, show, go, clear };
  const showResult = tab === "A" || tab === "B" || tab === "C" || tab === "refund" || tab === "expiry";
  const lastEntry = history[0] ?? null;

  return (
    <main className="mx-auto w-full max-w-[1400px] space-y-4 p-4 text-sm">
      <div className="rounded bg-amber-400 px-3 py-1 text-center font-bold text-black" data-testid="sandbox-banner">
        Środowisko testowe Stripe Sandbox — bez prawdziwych pieniędzy
      </div>
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-300 pb-2 dark:border-zinc-700">
        <div>
          <h1 className="text-lg font-bold">Laboratorium płatności: kaucje, prowizje i przelewy</h1>
          <p className="text-zinc-500">Jedna rezerwacja, trzy sposoby rozliczenia kaucji (A, B, C) i ich porównanie. Każda operacja jest naprawdę wykonywana w Stripe Sandbox.</p>
        </div>
        <div className="text-xs text-zinc-500" data-testid="config">
          {config?.ok && <>Stripe Sandbox · API {config.apiVersion}</>}
        </div>
      </header>

      {unavailable && (
        <div role="alert" className="rounded border border-red-600 p-2 text-red-700 dark:text-red-400" data-testid="unavailable">{unavailable}</div>
      )}

      <nav className="flex flex-wrap gap-1 border-b border-zinc-300 dark:border-zinc-700" aria-label="Scenariusze">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => go(t.id)} className={`rounded-t px-3 py-1.5 ${tab === t.id ? "bg-zinc-200 font-bold dark:bg-zinc-800" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "booking" && <BookingPanel ctx={ctx} />}
      {tab === "A" && <ScenarioA ctx={ctx} />}
      {tab === "B" && <ScenarioB ctx={ctx} />}
      {tab === "C" && <ScenarioC ctx={ctx} />}
      {tab === "compare" && <ComparePanel ctx={ctx} />}
      {tab === "refund" && <RefundScenario ctx={ctx} />}
      {tab === "expiry" && <ExpiryScenario ctx={ctx} />}
      {tab === "accounts" && <AccountsScenario accounts={accounts} accountsError={accountsError} balance={balance} onRefresh={() => void loadAccounts()} />}

      {showResult && <ScenarioResult ctx={ctx} loading={detailsLoading} lastEntry={lastEntry} />}

      <details className="panel">
        <summary className="cursor-pointer font-bold">Jak to działa — architektura i ograniczenia</summary>
        <div className="mt-2"><ArchitecturePanel /></div>
      </details>

      <details className="panel space-y-3">
        <summary className="cursor-pointer font-bold">Tryb zaawansowany (operacje Stripe, wyszukiwanie płatności, historia)</summary>
        <div className="mt-2 space-y-3">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const id = lookupId.trim();
              if (PI_RE.test(id)) show(id);
            }}
          >
            <label className="block">
              Wczytaj płatność laboratorium po ID (PaymentIntent)
              <input value={lookupId} onChange={(e) => setLookupId(e.target.value)} placeholder="pi_…" className="mt-1 block w-80 max-w-full rounded border px-2 py-1" data-testid="lookup" />
            </label>
            <button className="btn" type="submit" disabled={!PI_RE.test(lookupId.trim())}>Wczytaj</button>
            <label className="block">
              Karta testowa klienta
              <select value={card} onChange={(e) => setCard(e.target.value as TestPaymentMethod)} className="mt-1 block rounded border px-2 py-1">
                <option value="pm_card_visa">Visa (pm_card_visa)</option>
                <option value="pm_card_mastercard">Mastercard (pm_card_mastercard)</option>
                <option value="pm_card_visa_debit">Visa Debit (pm_card_visa_debit)</option>
              </select>
            </label>
            <label className="block">
              Model dla operacji technicznych
              <select value={advancedModel} onChange={(e) => setAdvancedModel(e.target.value as Model)} className="mt-1 block rounded border px-2 py-1">
                <option value="platform">Płatność platformowa</option>
                <option value="destination">Destination Charge</option>
                <option value="separate">Separate Charges and Transfers</option>
              </select>
            </label>
          </form>
          <PaymentWorkspace key={advancedModel} model={advancedModel} labAccount={labAccount} details={details} busy={busy} perform={perform} onPaymentIntent={show} />
          <HistoryPanel history={history} selected={selected} onSelect={setSelected} />
        </div>
      </details>
    </main>
  );
}
