"use client";

import type { AccountRow, BalanceResponse } from "./api";
import { dateTime, pln } from "./api";

type Props = {
  accounts: AccountRow[] | null;
  accountsError: string | null;
  balance: BalanceResponse | null;
  onRefresh: () => void;
};

const yes = (v: boolean) => (v ? <span className="text-green-700 dark:text-green-400">tak</span> : <span className="text-red-600">nie</span>);

export function AccountsPanel({ accounts, accountsError, balance, onRefresh }: Props) {
  return (
    <section className="panel space-y-3" data-testid="accounts-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-bold">Konta połączone (tylko odczyt)</h2>
        <button className="btn" onClick={onRefresh}>Odśwież</button>
      </div>
      <p className="text-xs text-zinc-500">
        Wyświetlane są wszystkie konta widoczne dla platformy. Płatności, przelewy i cofnięcia przelewów są dozwolone
        wyłącznie dla konta oznaczonego <code>metadata.lab = stripe-connect-lab</code>. Ograniczenie jest egzekwowane po
        stronie serwera przy każdej operacji. Gotowość konta laboratorium sprawdzana jest przez Accounts v2.
      </p>
      {accountsError && <p className="text-red-600">{accountsError}</p>}
      {!accounts && !accountsError && <p className="text-zinc-500">Wczytywanie…</p>}
      {accounts && (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Konto</th><th>Rola w laboratorium</th><th>type</th><th>Kraj / waluta</th><th>charges_enabled</th>
                <th>payouts_enabled</th><th>capabilities</th><th>Wymagania (currently_due)</th><th>Gotowość (v2)</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td className="whitespace-nowrap">{a.id}<div className="text-xs text-zinc-500">utworzone {dateTime(a.created_iso)}</div></td>
                  <td>
                    {a.isLabAccount ? (
                      <span className="badge badge-ok">konto laboratorium — może otrzymywać środki</span>
                    ) : (
                      <span className="badge">spoza laboratorium — tylko odczyt</span>
                    )}
                  </td>
                  <td>{a.type}</td>
                  <td>{a.country} / {a.default_currency}</td>
                  <td>{yes(a.charges_enabled)}</td>
                  <td>{yes(a.payouts_enabled)}</td>
                  <td className="whitespace-nowrap">
                    {Object.entries(a.capabilities).map(([k, v]) => (
                      <div key={k}>{k}: <b>{v}</b></div>
                    ))}
                  </td>
                  <td>{a.requirements.currently_due.length ? `${a.requirements.currently_due.length} pozycji` : "brak"}</td>
                  <td>
                    {a.readiness ? (
                      a.readiness.ready ? (
                        <span className="text-green-700 dark:text-green-400">gotowe</span>
                      ) : (
                        <span className="text-red-600">niegotowe: {a.readiness.reasons.join("; ")}</span>
                      )
                    ) : (
                      <span className="text-zinc-500">nie sprawdzano (konto tylko do odczytu)</span>
                    )}
                    {a.readiness && (
                      <div className="text-xs text-zinc-500">
                        card_payments {a.readiness.capabilities.card_payments}, stripe_transfers {a.readiness.capabilities.stripe_transfers},
                        payouts {a.readiness.capabilities.recipient_payouts}; waluta {a.readiness.currency}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {balance && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded border border-zinc-300 p-2 dark:border-zinc-700">
            <div className="font-bold">Saldo sprzedawcy {balance.seller.accountId}</div>
            <div>oczekujące (pending): <b>{pln(balance.seller.pending)}</b></div>
            <div>dostępne (available): <b>{pln(balance.seller.available)}</b></div>
          </div>
          <div className="rounded border border-zinc-300 p-2 dark:border-zinc-700">
            <div className="font-bold">Saldo platformy</div>
            <div>oczekujące (pending): <b>{pln(balance.platform.pending)}</b></div>
            <div>dostępne (available): <b>{pln(balance.platform.available)}</b></div>
          </div>
          <p className="text-xs text-zinc-500 sm:col-span-2">
            Salda całego konta (wszystkie testy laboratorium), stan z {dateTime(balance.fetchedAt)}. „Oczekujące” to środki
            zaksięgowane, ale jeszcze nierozliczone; wypłaty nie są częścią laboratorium.
          </p>
        </div>
      )}
    </section>
  );
}
