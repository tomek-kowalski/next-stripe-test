"use client";

export type HistoryEntry = {
  id: number;
  at: string;
  label: string;
  httpStatus: number;
  ok: boolean;
  message: string;
  requestId: string | null;
  idempotencyKey: string | null;
  objectId: string | null;
  raw: unknown;
};

type Props = { history: HistoryEntry[]; selected: HistoryEntry | null; onSelect: (h: HistoryEntry) => void };

export function HistoryPanel({ history, selected, onSelect }: Props) {
  return (
    <section className="grid gap-3 xl:grid-cols-2">
      <div className="panel">
        <h2 className="mb-2 font-bold">Historia operacji (tylko ta sesja przeglądarki)</h2>
        <p className="mb-2 text-xs text-zinc-500">Request ID pochodzą z odpowiedzi Stripe na żądania z tej karty; po odświeżeniu strony historia znika (brak bazy danych).</p>
        {history.length === 0 && <p className="text-zinc-500">Brak operacji.</p>}
        <ol className="max-h-[420px] space-y-1 overflow-auto" data-testid="history">
          {history.map((h) => (
            <li key={h.id}>
              <button onClick={() => onSelect(h)} className={`w-full rounded px-2 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 ${selected?.id === h.id ? "bg-zinc-100 dark:bg-zinc-800" : ""}`}>
                <span className={h.ok ? "text-green-600" : "text-red-600"}>{h.ok ? "OK " : "BŁĄD"}</span> {h.at} · {h.label} · HTTP {h.httpStatus}
                <div className="truncate text-xs text-zinc-500">{h.message}</div>
                <div className="truncate text-xs text-zinc-500">request {h.requestId ?? "—"} · obiekt {h.objectId ?? "—"} · idempotency {h.idempotencyKey ?? "—"}</div>
              </button>
            </li>
          ))}
        </ol>
      </div>
      <div className="panel min-w-0">
        <h2 className="mb-2 font-bold">Surowa odpowiedź Stripe {selected && `· ${selected.label}`}</h2>
        <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-all text-xs" data-testid="raw">
          {selected ? JSON.stringify(selected.raw, null, 2) : "Wybierz operację z historii."}
        </pre>
      </div>
    </section>
  );
}
