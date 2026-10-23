"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LabConfig } from "@/lib/lab/types";
import { AccountsPanel } from "./accounts-panel";
import type { AccountsResponse, ApiError, ApiResult, BalanceResponse, PaymentDetails } from "./api";
import { api, errorText, STATUS_PL } from "./api";
import { ArchitecturePanel } from "./architecture-panel";
import { ExpirySimulation } from "./expiry-simulation";
import { HistoryPanel, type HistoryEntry } from "./history-panel";
import { PaymentDetailsPanel } from "./payment-details-panel";
import { PaymentWorkspace, type Model } from "./payment-workspace";
import { TimelinePanel } from "./timeline-panel";

type Tab = "platform" | "destination" | "separate" | "expiry" | "accounts" | "architecture";

const TABS: { id: Tab; label: string; intro: string }[] = [
  { id: "platform", label: "1. Autoryzacja i przechwycenie", intro: "Kaucja na platformie: autoryzacja (blokada środków), przechwycenie całości lub części, anulowanie i zwrot. Bez konta sprzedawcy." },
  { id: "destination", label: "2. Destination Charge", intro: "Obciążenie na platformie z automatycznym przelewem do sprzedawcy przy przechwyceniu i prowizją platformy (application fee). Zwrot może od razu cofnąć przelew i prowizję." },
  { id: "separate", label: "3. Separate Charges and Transfers", intro: "Platforma pobiera płatność, a przelew do sprzedawcy tworzy osobno (np. po zakończeniu najmu). Zwrot i cofnięcie przelewu to dwie osobne operacje." },
  { id: "expiry", label: "4. Wygaśnięcie autoryzacji", intro: "Termin capture_before ze Stripe oraz symulacja skutków wygaśnięcia (bez operacji Stripe)." },
  { id: "accounts", label: "Konta połączone", intro: "Wszystkie konta połączone i ich capabilities — tylko odczyt." },
  { id: "architecture", label: "Jak to działa", intro: "Architektura, odpowiedzialność za opłaty i zwroty, ograniczenia oraz wymagania produkcyjne." },
];

const PI_RE = /^pi_[A-Za-z0-9]+$/;
let nextHistoryId = 1;

type AccountsData = { accounts: AccountsResponse | null; error: string | null; balance: BalanceResponse | null };

async function fetchAccountsData(): Promise<AccountsData> {
  const r = await api<AccountsResponse>("GET", "/api/lab/connect/accounts");
  if (!r.ok) return { accounts: null, error: errorText(r), balance: null };
  const lab = r.body.accounts.find((a) => a.isLabAccount);
  const b = lab ? await api<BalanceResponse>("GET", `/api/lab/connect/accounts/${lab.id}/balance`) : null;
  return { accounts: r.body, error: null, balance: b?.ok ? b.body : null };
}

export function LabDashboard() {
  const [tab, setTab] = useState<Tab>("platform");
  const [config, setConfig] = useState<LabConfig | null>(null);
  const [accounts, setAccounts] = useState<AccountsResponse | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [balance, setBalance] = useState<BalanceResponse | null>(null);
  const [details, setDetails] = useState<PaymentDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [lookupId, setLookupId] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [selected, setSelected] = useState<HistoryEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const currentId = useRef<string | null>(null);
  const refreshTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const labAccount = accounts?.accounts.find((a) => a.isLabAccount) ?? null;

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
    else {
      setDetails(null);
      setNotice({ ok: false, text: `Nie można wczytać ${id}: ${errorText(r)}` });
    }
  }, []);

  /** Stripe creates transfers, fees and balance transactions asynchronously: re-read a few times. */
  const showPaymentIntent = useCallback(
    (id: string) => {
      refreshTimers.current.forEach(clearTimeout);
      void loadDetails(id);
      refreshTimers.current = [2500, 6000, 12000].map((ms) => setTimeout(() => void loadDetails(id), ms));
    },
    [loadDetails],
  );

  useEffect(() => {
    void api<LabConfig>("GET", "/api/lab/config").then((r) => setConfig(r.ok ? r.body : { ok: false, message: errorText(r), apiVersion: "?", sdkVersion: "?" }));
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
    const message = r.ok
      ? `${label}: OK${summary?.status ? ` → ${summary.status} (${STATUS_PL[summary.status] ?? ""})` : ""}`
      : `${label}: ${errorText({ httpStatus: r.httpStatus, body: r.body as ApiError })}`;
    const entry: HistoryEntry = {
      id: nextHistoryId++,
      at: new Date().toLocaleTimeString("pl-PL"),
      label,
      httpStatus: r.httpStatus,
      ok: r.ok,
      message,
      requestId: (b.requestId as string | null | undefined) ?? null,
      idempotencyKey: (b.idempotencyKey as string | null | undefined) ?? null,
      objectId: (b.objectId as string | undefined) ?? summary?.id ?? null,
      raw: b.raw ?? b,
    };
    setHistory((h) => [entry, ...h]);
    setSelected(entry);
    setNotice({ ok: r.ok, text: message });
    if (r.ok) void loadAccounts();
    return r;
  }, [loadAccounts]);

  const current = TABS.find((t) => t.id === tab)!;
  const isPaymentTab = tab === "platform" || tab === "destination" || tab === "separate";

  return (
    <main className="mx-auto w-full max-w-[1500px] space-y-4 p-4 font-mono text-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-300 pb-2 dark:border-zinc-700">
        <div>
          <h1 className="text-lg font-bold">Laboratorium Stripe Connect — kaucje C2C</h1>
          <p className="text-xs text-zinc-500">Proof of Concept · wyłącznie Stripe Sandbox · tylko lokalnie (localhost) · waluta PLN</p>
        </div>
        <div className="text-xs text-zinc-500" data-testid="config">
          {!config && "wczytywanie konfiguracji…"}
          {config?.ok === false && <span className="text-red-600">Błąd konfiguracji: {config.message}</span>}
          {config?.ok && <>TRYB TESTOWY · platforma {config.account?.id ?? "?"} {config.account?.country ?? ""} · API {config.apiVersion} · stripe-node {config.sdkVersion}</>}
        </div>
      </header>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const id = lookupId.trim();
          if (!PI_RE.test(id)) return setNotice({ ok: false, text: "Podaj identyfikator PaymentIntent w formacie pi_…" });
          showPaymentIntent(id);
        }}
      >
        <label className="block">
          Wczytaj PaymentIntent laboratorium (tylko odczyt, bez bazy danych)
          <input value={lookupId} onChange={(e) => setLookupId(e.target.value)} placeholder="pi_…" className="mt-1 block w-80 max-w-full rounded border px-2 py-1" data-testid="lookup" />
        </label>
        <button className="btn" type="submit">Wczytaj</button>
        {details && <button className="btn" type="button" onClick={() => showPaymentIntent(details.summary.id)}>Odśwież szczegóły</button>}
      </form>

      {notice && (
        <div role="status" data-testid="notice" className={`rounded border p-2 ${notice.ok ? "border-green-600 text-green-700 dark:text-green-400" : "border-red-600 text-red-700 dark:text-red-400"}`}>
          {notice.text}
        </div>
      )}

      <nav className="flex flex-wrap gap-1 border-b border-zinc-300 dark:border-zinc-700" aria-label="Scenariusze">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`rounded-t px-3 py-1 ${tab === t.id ? "bg-zinc-200 font-bold dark:bg-zinc-800" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}>
            {t.label}
          </button>
        ))}
      </nav>
      <p className="text-zinc-600 dark:text-zinc-400">{current.intro}</p>

      {isPaymentTab && (
        <PaymentWorkspace key={tab} model={tab as Model} labAccount={labAccount} details={details} busy={busy} perform={perform} onPaymentIntent={showPaymentIntent} />
      )}
      {tab === "expiry" && <ExpirySimulation details={details} />}
      {tab === "accounts" && <AccountsPanel accounts={accounts?.accounts ?? null} accountsError={accountsError} balance={balance} onRefresh={() => void loadAccounts()} />}
      {tab === "architecture" && <ArchitecturePanel />}

      {(isPaymentTab || tab === "expiry") && (
        <>
          <PaymentDetailsPanel details={details} loading={detailsLoading} />
          <TimelinePanel details={details} />
        </>
      )}
      <HistoryPanel history={history} selected={selected} onSelect={setSelected} />
    </main>
  );
}
