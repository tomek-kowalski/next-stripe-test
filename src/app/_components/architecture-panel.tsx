// Static explanation for client presentations. Every statement is labeled either as
// verified in this lab's Sandbox runs (docs/phase-*.md) or as taken from Stripe documentation.

const V = () => <span className="badge badge-ok">zweryfikowane w Sandbox</span>;
const D = () => <span className="badge">wg dokumentacji Stripe</span>;

export function ArchitecturePanel() {
  return (
    <section className="panel space-y-4 leading-relaxed" data-testid="architecture-panel">
      <h2 className="font-bold">Jak to działa — architektura płatności C2C na Stripe Connect</h2>

      <div>
        <h3 className="font-bold">Cykl życia kaucji (autoryzacja → przechwycenie)</h3>
        <ol className="ml-5 list-decimal">
          <li><b>Autoryzacja</b> (<code>capture_method: manual</code>): środki są blokowane na karcie najemcy, nic nie jest księgowane. <V /></li>
          <li><b>Przechwycenie całości lub części</b> — tylko raz; niewykorzystana reszta blokady jest zwalniana bez obiektu Refund. <V /></li>
          <li><b>Anulowanie</b> przed przechwyceniem zwalnia blokadę bez kosztów (brak balance transactions). <V /></li>
          <li><b>Termin</b>: <code>capture_before</code> = 7 dni od autoryzacji; po nim Stripe zwalnia blokadę i ustawia <code>canceled</code>. <V /> (termin) / <D /> (skutek)</li>
        </ol>
      </div>

      <div className="overflow-x-auto">
        <h3 className="font-bold">Porównanie modeli obciążeń</h3>
        <table className="table">
          <thead>
            <tr><th></th><th>Płatność platformowa</th><th>Destination Charge</th><th>Separate Charges and Transfers</th><th>Direct Charge (nie testowano)</th></tr>
          </thead>
          <tbody>
            <tr><td>Gdzie powstaje obciążenie</td><td>platforma</td><td>platforma</td><td>platforma</td><td>konto sprzedawcy</td></tr>
            <tr><td>Środki sprzedawcy</td><td>brak</td><td>automatyczny przelew całej kwoty przy przechwyceniu, prowizja (application fee) wraca do platformy <V /></td><td>platforma tworzy przelewy sama: dowolna kwota i moment (ograniczone kwotą obciążenia) <V /></td><td>rozliczane na koncie sprzedawcy <D /></td></tr>
            <tr><td>Opłata Stripe</td><td>platforma <V /></td><td>platforma <V /></td><td>platforma <V /></td><td>sprzedawca <D /></td></tr>
            <tr><td>Zwrot obciąża</td><td>platformę <V /></td><td>platformę; odzyskanie od sprzedawcy przez <code>reverse_transfer</code> w tym samym wywołaniu <V /></td><td>platformę; przelew trzeba cofnąć osobno — do tego czasu sprzedawca zachowuje środki <V /></td><td>sprzedawcę <D /></td></tr>
            <tr><td>Spory (chargeback)</td><td>platforma <D /></td><td>platforma, może cofnąć przelew <D /></td><td>platforma, może cofnąć przelew <D /></td><td>sprzedawca <D /></td></tr>
            <tr><td>Ujemne saldo sprzedawcy</td><td>—</td><td colSpan={3}>platforma (konto laboratorium: <code>losses_collector: application</code>) <V /></td></tr>
          </tbody>
        </table>
      </div>

      <div>
        <h3 className="font-bold">Ekonomia na 50,00 PLN (karta testowa <code>pm_card_visa</code>)</h3>
        <ul className="ml-5 list-disc">
          <li>Prowizja 10%: sprzedawca 45,00 PLN, platforma <b>2,37 PLN</b> netto (opłata Stripe 2,63 PLN). <V /></li>
          <li>Pełny zwrot po przechwyceniu: platforma <b>−2,63 PLN</b> — Stripe nie zwraca swojej opłaty. <V /></li>
          <li>Opłata pasuje do 3,25% + 1,00 PLN; karta testowa jest wydana w USA, więc stawka dla kart polskich może być inna. <V /> (2 pomiary)</li>
          <li>Brak przewalutowania przy PLN. <V /></li>
        </ul>
      </div>

      <div>
        <h3 className="font-bold">Ograniczenia techniczne laboratorium</h3>
        <ul className="ml-5 list-disc">
          <li>Brak bazy danych: powiązania płatność ↔ przelew ↔ zwrot żyją tylko w Stripe (metadata, <code>transfer_group</code>); historia operacji jest tylko w tej karcie przeglądarki.</li>
          <li>Żadne środki nie zostały rozliczone — wszystkie balance transactions są <code>pending</code> (7 dni); wypłaty nie są testowane.</li>
          <li>Przelew i application fee w Destination Charge powstają asynchronicznie (~3,5 s po <code>succeeded</code>). <V /></li>
          <li>Filtr <code>source</code> listy balance transactions nie zwraca wszystkich wpisów danego źródła (np. <code>transfer_refund</code>, <code>adjustment</code>); trzeba szukać po ID cofnięcia lub dopasowywać po polu <code>source</code>. <V /></li>
          <li>Wygaśnięcia autoryzacji nie da się wywołać w Sandbox — pokazujemy symulację. <D /></li>
          <li>Konto Express: platforma nie może sama dokończyć KYC (Stripe odrzuca zapis np. daty urodzenia po onboardingu przez Account Link). <V /></li>
          <li>Tworzenie kont przez Accounts v1 jest zablokowane; konto utworzono przez Accounts v2. <V /></li>
        </ul>
      </div>

      <div>
        <h3 className="font-bold">Wymagania wdrożenia produkcyjnego (poza zakresem PoC)</h3>
        <ul className="ml-5 list-disc">
          <li>Trwały rejestr operacji (ledger) z kluczami idempotencji i ponawianiem — np. zwrot + cofnięcie przelewu jako jedna operacja biznesowa.</li>
          <li>Webhooki z weryfikacją podpisu, deduplikacją i obsługą kolejności zdarzeń jako źródło prawdy o stanie.</li>
          <li>Harmonogram pilnujący <code>capture_before</code> (przechwyć/anuluj przed terminem, inaczej kaucja przepada).</li>
          <li>Uzgadnianie (reconciliation) sald i wypłat, obsługa sporów oraz ujemnych sald sprzedawców.</li>
          <li>Onboarding i aktualizacja danych sprzedawców przez hostowane formularze Stripe, monitorowanie wymagań konta.</li>
        </ul>
      </div>
    </section>
  );
}
