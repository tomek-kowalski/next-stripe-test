"use client";

import { useEffect, useState } from "react";
import type { PaymentDetails } from "./api";
import { dateTime } from "./api";

const DOC_URL = "https://docs.stripe.com/payments/place-a-hold-on-a-payment-method";

function duration(ms: number) {
  const abs = Math.abs(ms);
  const d = Math.floor(abs / 864e5);
  const h = Math.floor((abs % 864e5) / 36e5);
  const m = Math.floor((abs % 36e5) / 6e4);
  return `${d} d ${h} h ${m} min`;
}

/**
 * Browser-only simulation. Stripe Sandbox has no documented mechanism to make a card
 * authorization expire on demand, so the expiry outcome is shown from Stripe's
 * documentation, never from a Stripe call.
 */
export function ExpirySimulation({ details }: { details: PaymentDetails | null }) {
  const [now, setNow] = useState(() => Date.now());
  const [simulatedNow, setSimulatedNow] = useState<number | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const status = details?.summary.status ?? null;
  const captureBeforeIso = details?.summary.charge?.authorization?.capture_before_iso ?? null;
  const captureBefore = captureBeforeIso ? Date.parse(captureBeforeIso) : null;
  const clock = simulatedNow ?? now;
  const expiredInSimulation = simulatedNow !== null && captureBefore !== null && simulatedNow >= captureBefore;
  const canSimulate = status === "requires_capture" && captureBefore !== null;

  return (
    <section className="panel space-y-3" data-testid="expiry-panel">
      <h2 className="font-bold">Wygaśnięcie autoryzacji</h2>
      <p className="text-xs text-zinc-500">
        Wynik badania: dokumentacja Stripe (strony o blokadzie środków, testowaniu i extended authorization) nie opisuje
        mechanizmu Sandbox pozwalającego wymusić wygaśnięcie autoryzacji karty. Dlatego wygaśnięcie jest pokazane jako
        symulacja w przeglądarce, oparta na dokumentacji.
      </p>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded border border-green-600 p-3">
          <h3 className="font-bold text-green-700 dark:text-green-400">Zweryfikowane w Stripe Sandbox</h3>
          {!details ? (
            <p className="text-zinc-500">Najpierw autoryzuj płatność (zakładka „Autoryzacja i przechwycenie”) lub wczytaj PaymentIntent.</p>
          ) : (
            <ul className="space-y-1">
              <li>PaymentIntent: {details.summary.id}</li>
              <li>status (ze Stripe): <code>{status}</code></li>
              <li><code>capture_before</code>: {captureBeforeIso ? dateTime(captureBeforeIso) : "— (brak; płatność nie jest autoryzacją oczekującą na przechwycenie)"}</li>
              {captureBefore !== null && status === "requires_capture" && (
                <li>pozostało (rzeczywisty zegar): <b>{captureBefore > now ? duration(captureBefore - now) : "termin minął"}</b></li>
              )}
              <li className="text-xs text-zinc-500">Zaobserwowane w fazach 1–2: <code>capture_before</code> = 168 h (7 dni) po autoryzacji; extended authorization: <code>disabled</code>.</li>
            </ul>
          )}
        </div>

        <div className="rounded border-4 border-dashed border-amber-500 p-3" data-testid="simulation">
          <div className="mb-2 rounded bg-amber-500 px-2 py-1 text-center font-bold text-black">SYMULACJA — bez operacji Stripe</div>
          {!canSimulate ? (
            <p className="text-zinc-500">
              Symulacja wymaga płatności w statusie <code>requires_capture</code> z podanym <code>capture_before</code>
              {status && ` (obecnie: ${status})`}.
            </p>
          ) : (
            <div className="space-y-2">
              <div>symulowany zegar: <b>{dateTime(new Date(clock).toISOString())}</b>{simulatedNow === null && " (rzeczywisty)"}</div>
              <div className="flex flex-wrap gap-2">
                <button className="btn" onClick={() => setSimulatedNow(captureBefore! - 36e5)}>Przewiń do 1 h przed terminem</button>
                <button className="btn" onClick={() => setSimulatedNow(captureBefore! + 6e4)}>Przewiń za termin</button>
                <button className="btn" disabled={simulatedNow === null} onClick={() => setSimulatedNow(null)}>Reset</button>
              </div>
              {simulatedNow !== null && !expiredInSimulation && (
                <p>Przed terminem: płatność można jeszcze przechwycić (całość lub część) albo anulować. Pozostało {duration(captureBefore! - simulatedNow)}.</p>
              )}
              {expiredInSimulation && (
                <div className="rounded bg-amber-100 p-2 text-black">
                  <b>Symulowany wynik po terminie (wg dokumentacji Stripe, nie z Sandbox):</b>
                  <ul className="ml-4 list-disc">
                    <li>środki zablokowane na karcie zostają zwolnione,</li>
                    <li>status PaymentIntent zmienia się na <code>canceled</code>,</li>
                    <li>przechwycenie nie jest już możliwe — kaucję trzeba pobrać nową płatnością (nie da się automatycznie odnowić wygasłej autoryzacji).</li>
                  </ul>
                  <p className="mt-1 text-xs">
                    Źródło: „If the authorization expires before you capture the funds, the funds are released and the payment
                    status changes to canceled.” — <a className="underline" href={DOC_URL} target="_blank" rel="noreferrer">{DOC_URL}</a>.
                    Dokumentacja nie podaje kodu błędu ani <code>cancellation_reason</code>, więc ich nie pokazujemy.
                  </p>
                </div>
              )}
              <p className="text-xs text-zinc-500">Rzeczywisty status w Stripe pozostaje bez zmian: <code>{status}</code>.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
