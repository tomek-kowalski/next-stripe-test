"use client";

import type { PaymentDetails } from "./api";
import { pln } from "./api";
import { readMoney } from "./money";

type Kind = "capture" | "fee" | "commission" | "transfer" | "refund" | "reversal";
type Flow = { from: 1 | 2 | 3 | 4; to: 1 | 2 | 3 | 4; label: string; amount: number; kind: Kind };

const KIND_STYLE: Record<Kind, string> = {
  capture: "border-blue-600 bg-blue-50 text-blue-900 dark:bg-blue-950 dark:text-blue-100",
  fee: "border-zinc-500 bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100",
  commission: "border-purple-600 bg-purple-50 text-purple-900 dark:bg-purple-950 dark:text-purple-100",
  transfer: "border-green-600 bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-100",
  refund: "border-red-600 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100",
  reversal: "border-orange-600 bg-orange-50 text-orange-900 dark:bg-orange-950 dark:text-orange-100",
};

const LEGEND: [Kind, string][] = [
  ["capture", "pobranie od klienta"],
  ["fee", "opłata Stripe"],
  ["commission", "prowizja platformy"],
  ["transfer", "przelew do sprzedawcy"],
  ["refund", "zwrot dla klienta"],
  ["reversal", "cofnięcie przelewu / zwrot prowizji"],
];

const NODES = ["Klient", "Platforma", "Stripe", "Sprzedawca"];

/** Money movements read from real Stripe objects and balance transactions. */
export function MoneyFlow({ details }: { details: PaymentDetails }) {
  const m = readMoney(details);
  const s = details.summary;
  const model = s.connect.charge_model;

  const flows: Flow[] = [];
  if (m.captured > 0) flows.push({ from: 1, to: 2, label: "pobrano od klienta", amount: m.captured, kind: "capture" });
  if (m.stripeFee > 0) flows.push({ from: 2, to: 3, label: "opłata Stripe", amount: m.stripeFee, kind: "fee" });
  if (m.transfersGross > 0) flows.push({ from: 2, to: 4, label: "przelew do sprzedawcy", amount: m.transfersGross, kind: "transfer" });
  if (m.commissionGross > 0) flows.push({ from: 4, to: 2, label: "prowizja platformy", amount: m.commissionGross, kind: "commission" });
  if (m.commissionRefunded > 0) flows.push({ from: 2, to: 4, label: "zwrot prowizji sprzedawcy", amount: m.commissionRefunded, kind: "reversal" });
  if (m.reversals > 0) flows.push({ from: 4, to: 2, label: "cofnięcie przelewu", amount: m.reversals, kind: "reversal" });
  if (m.refunded > 0) flows.push({ from: 2, to: 1, label: "zwrot dla klienta", amount: m.refunded, kind: "refund" });

  const customerNote =
    s.status === "requires_capture" ? (
      <div className="mt-1 rounded border-2 border-dashed border-amber-500 p-1 text-xs">🔒 zablokowane na karcie: <b>{pln(m.held)}</b><br />(nie pobrane — to nie jest przelew)</div>
    ) : m.released > 0 ? (
      <div className="mt-1 rounded border border-dashed border-zinc-400 p-1 text-xs">🔓 zwolniono z blokady: <b>{pln(m.released)}</b></div>
    ) : null;

  const nodeTotals = [
    m.captured - m.refunded > 0 ? `zapłacił netto ${pln(m.captured - m.refunded)}` : "zapłacił 0,00 zł",
    `wynik ${pln(m.platformNet)}`,
    `opłaty ${pln(m.stripeFee)}`,
    model === "platform" ? "nie uczestniczy" : `ma ${pln(m.sellerNet)}`,
  ];

  return (
    <div className="space-y-2" data-testid="money-flow">
      <div className="grid grid-cols-4 gap-2 text-center">
        {NODES.map((n, i) => (
          <div key={n} className="rounded border-2 border-zinc-400 p-2">
            <div className="font-bold">{n}</div>
            <div className="text-xs text-zinc-500">{nodeTotals[i]}</div>
            {i === 0 && customerNote}
            {i === 3 && model !== "platform" && (m.sellerPending !== 0 || m.sellerAvailable !== 0) && (
              <div className="text-xs text-zinc-500">oczekujące {pln(m.sellerPending)} · dostępne {pln(m.sellerAvailable)}</div>
            )}
            {i === 1 && (m.platformPending !== 0 || m.platformAvailable !== 0) && (
              <div className="text-xs text-zinc-500">oczekujące {pln(m.platformPending)} · dostępne {pln(m.platformAvailable)}</div>
            )}
          </div>
        ))}
      </div>

      {flows.length === 0 ? (
        <p className="text-center text-zinc-500">
          {s.status === "requires_capture" ? "Żadne pieniądze jeszcze się nie przemieściły — istnieje tylko blokada na karcie." : "Brak przepływów pieniędzy (lub Stripe jeszcze ich nie zapisał — odświeżamy)."}
        </p>
      ) : (
        <div className="grid grid-cols-4 gap-x-2 gap-y-1">
          {flows.map((f, i) => {
            const left = Math.min(f.from, f.to);
            const right = Math.max(f.from, f.to);
            const forward = f.to > f.from;
            return (
              <div key={i} style={{ gridColumn: `${left} / ${right + 1}` }} className={`flex items-center justify-between rounded border px-2 py-0.5 text-xs ${KIND_STYLE[f.kind]}`}>
                <span>{forward ? "" : "◀"}</span>
                <span>{f.label}: <b>{pln(f.amount)}</b></span>
                <span>{forward ? "▶" : ""}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap gap-2 text-xs">
        {LEGEND.map(([k, label]) => (
          <span key={k} className={`rounded border px-1.5 ${KIND_STYLE[k]}`}>{label}</span>
        ))}
        <span className="rounded border-2 border-dashed border-amber-500 px-1.5">🔒 blokada (bez ruchu pieniędzy)</span>
      </div>
      {model === "destination" && m.transfersGross > 0 && (
        <p className="text-xs text-zinc-500">Tak działa Stripe przy podziale płatności: najpierw przekazuje sprzedawcy całą kwotę, a prowizja platformy wraca od sprzedawcy jako osobna pozycja.</p>
      )}
    </div>
  );
}
