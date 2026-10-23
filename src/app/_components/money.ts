// Plain-language reading of a payment, built only from real Stripe data (details endpoint).
import type { PaymentDetails } from "./api";
import { pln } from "./api";

export type Money = {
  held: number;
  captured: number;
  released: number;
  refunded: number;
  stripeFee: number;
  transfersGross: number;
  reversals: number;
  commissionGross: number;
  commissionRefunded: number;
  /** Separate charges: what the platform kept from the customer's money. */
  keptBySeparate: number;
  platformNet: number;
  sellerNet: number;
  sellerPending: number;
  sellerAvailable: number;
  platformPending: number;
  platformAvailable: number;
  refundable: number;
  transferable: number;
  reversibleTransferId: string | null;
  reversibleAmount: number;
};

export function readMoney(d: PaymentDetails): Money {
  const s = d.summary;
  const o = d.objects;
  const captured = o.charge?.amount_captured ?? 0;
  const refunded = o.charge?.amount_refunded ?? 0;
  const held = s.status === "requires_capture" ? s.amount_capturable : 0;
  // A partial capture releases the rest of the hold; a cancelled hold releases everything.
  const released = s.status === "succeeded" && s.capture_method === "manual" ? Math.max(s.amount - captured, 0) : s.status === "canceled" ? s.amount : 0;
  const transfersGross = o.transfers.reduce((n, t) => n + t.amount, 0);
  const reversals = o.transferReversals.reduce((n, r) => n + r.amount, 0);
  const transferredNet = o.transfers.reduce((n, t) => n + t.amount - t.amount_reversed, 0);
  const reversible = o.transfers.find((t) => t.amount - t.amount_reversed > 0) ?? null;
  return {
    held,
    captured,
    released,
    refunded,
    stripeFee: d.funds.stripeFees,
    transfersGross,
    reversals,
    commissionGross: o.applicationFee?.amount ?? 0,
    commissionRefunded: o.applicationFee?.amount_refunded ?? 0,
    keptBySeparate: s.connect.charge_model === "separate" ? captured - refunded - transferredNet : 0,
    platformNet: d.funds.platformNet,
    sellerNet: d.funds.sellerNet,
    sellerPending: d.funds.sellerPending,
    sellerAvailable: d.funds.sellerAvailable,
    platformPending: d.funds.platformPending,
    platformAvailable: d.funds.platformAvailable,
    refundable: captured - refunded,
    transferable: s.connect.charge_model === "separate" && s.status === "succeeded" ? captured - refunded - transferredNet : 0,
    reversibleTransferId: reversible?.id ?? null,
    reversibleAmount: reversible ? reversible.amount - reversible.amount_reversed : 0,
  };
}

/** Sentences describing what happened to the money, in Polish. */
export function moneyStory(d: PaymentDetails): string[] {
  const m = readMoney(d);
  const s = d.summary;
  const out: string[] = [];
  if (s.status === "requires_payment_method" || s.status === "requires_confirmation") {
    out.push("Płatność została przygotowana, ale karta klienta nie została jeszcze użyta. Nic nie zablokowano.");
    return out;
  }
  if (s.status === "requires_capture") {
    out.push(`Na karcie klienta zablokowano ${pln(m.held)}. Pieniądze nie zostały pobrane — to tylko blokada (autoryzacja).`);
    if (d.authorizationDeadline) out.push(`Blokadę trzeba pobrać albo zwolnić przed ${new Date(d.authorizationDeadline.capture_before_iso).toLocaleString("pl-PL")}.`);
    return out;
  }
  if (s.status === "canceled") {
    out.push(m.captured === 0 ? `Blokada ${pln(s.amount)} została zwolniona. Klient nie zapłacił nic, platforma nie poniosła kosztów.` : "Płatność anulowana.");
    return out;
  }
  if (m.captured > 0) out.push(`Od klienta pobrano ${pln(m.captured)}.`);
  if (m.released > 0) out.push(`Pozostałe ${pln(m.released)} z blokady wróciło do dyspozycji klienta (bez kosztów, bez zwrotu — po prostu zwolniono blokadę).`);
  if (m.refunded > 0) out.push(`Klientowi zwrócono ${pln(m.refunded)}.`);
  if (m.stripeFee > 0) out.push(`Stripe pobrał od platformy opłatę ${pln(m.stripeFee)}${m.refunded > 0 ? " — nie zwraca jej przy zwrocie" : ""}.`);
  if (m.transfersGross > 0) out.push(`Do sprzedawcy przekazano ${pln(m.transfersGross)}${m.reversals > 0 ? `, z czego cofnięto ${pln(m.reversals)}` : ""}.`);
  if (m.commissionGross > 0) out.push(`Prowizja platformy: ${pln(m.commissionGross)}${m.commissionRefunded > 0 ? ` (zwrócono sprzedawcy ${pln(m.commissionRefunded)})` : ""}.`);
  if (s.connect.charge_model !== "platform") out.push(`Sprzedawca ma z tej płatności ${pln(m.sellerNet)}.`);
  out.push(`Wynik platformy po opłacie Stripe: ${pln(m.platformNet)}${m.platformNet < 0 ? " (strata)" : ""}.`);
  if (m.platformPending !== 0 || m.sellerPending !== 0) {
    out.push("Kwoty są zaksięgowane w Stripe, ale jeszcze nierozliczone („oczekujące”) — w Sandbox stają się dostępne po ok. 7 dniach.");
  }
  return out;
}
