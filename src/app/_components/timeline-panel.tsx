"use client";

import type { PaymentDetails } from "./api";
import { dateTime, EVENT_PL } from "./api";

export function TimelinePanel({ details }: { details: PaymentDetails | null }) {
  if (!details) return null;
  const { timeline, authorizationDeadline: deadline, timelineScanned } = details;
  return (
    <section className="panel space-y-2" data-testid="timeline-panel">
      <h2 className="font-bold">Oś czasu płatności</h2>
      <p className="text-xs text-zinc-500">
        Zdarzenia pochodzą z Stripe Events API: czas to <code>event.created</code> nadany przez Stripe, a request ID to{" "}
        <code>event.request.id</code>. Brak request ID oznacza zmianę wykonaną przez Stripe bez bezpośredniego żądania (np.
        asynchroniczny przelew po przechwyceniu). Zdarzenia zapisywane są z opóźnieniem i przechowywane 30 dni, więc oś czasu
        może być chwilowo niepełna; niczego nie uzupełniamy ani nie odtwarzamy z dat utworzenia obiektów.
      </p>
      {timeline.length === 0 ? (
        <p className="text-zinc-500">Brak zdarzeń dla tej płatności (jeszcze nie zapisane albo starsze niż 30 dni).</p>
      ) : (
        <ol className="relative ml-2 border-l border-zinc-300 dark:border-zinc-700">
          {timeline.map((e) => (
            <li key={e.eventId} className="mb-2 ml-4">
              <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full bg-zinc-500" />
              <div>
                <b>{EVENT_PL[e.type] ?? e.type}</b> <code className="text-xs">{e.type}</code>
                {e.account === "connected" && <span className="badge ml-1">konto sprzedawcy</span>}
              </div>
              <div className="text-xs text-zinc-500">
                {dateTime(e.at_iso)} · {e.objectId} · {e.eventId} · request: {e.requestId ?? "— (zmiana po stronie Stripe)"}
              </div>
            </li>
          ))}
        </ol>
      )}
      {deadline && (
        <div className={`ml-2 rounded border-2 border-dashed p-2 ${deadline.passed ? "border-red-500" : "border-amber-500"}`}>
          <b>{deadline.passed ? "Termin autoryzacji minął" : "Przyszły termin: wygaśnięcie autoryzacji"}</b>
          <div className="text-xs">
            <code>capture_before</code> = {dateTime(deadline.capture_before_iso)} — to termin, a nie zdarzenie. Przed nim należy
            przechwycić lub anulować płatność; później Stripe zwalnia blokadę i ustawia status <code>canceled</code>.
          </div>
        </div>
      )}
      <p className="text-xs text-zinc-500">
        Przeskanowano zdarzeń: platforma {timelineScanned.platform}, sprzedawca {timelineScanned.connected}
        {timelineScanned.truncated && " (limit skanowania osiągnięty — oś czasu może być niepełna)"}.
      </p>
    </section>
  );
}
