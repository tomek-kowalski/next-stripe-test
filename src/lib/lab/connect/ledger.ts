import type Stripe from "stripe";

export type LedgerEntry = {
  id: string;
  type: string;
  reporting_category: string;
  source: string | null;
  amount: number;
  fee: number;
  net: number;
  currency: string;
  exchange_rate: number | null;
  /** A balance transaction can be recorded but still not settled (`pending`). */
  status: string;
  available_on_iso: string;
  created_iso: string;
  fee_details: { type: string; amount: number; description: string | null }[];
  description: string | null;
  /** Platform only: true when the source is one of this scenario's own objects. */
  attributed: boolean;
};

export type LedgerTotals = {
  net: number;
  stripeFees: number;
  pendingNet: number;
  availableNet: number;
  currencies: string[];
  currencyConversion: boolean;
};

export type Ledger = {
  platform: LedgerEntry[];
  connected: LedgerEntry[];
  /** Platform balance transactions created during the run whose source is not a scenario object. */
  unattributedPlatform: LedgerEntry[];
  platformTotals: LedgerTotals;
  connectedTotals: LedgerTotals;
};

const iso = (s: number) => new Date(s * 1000).toISOString();

function toEntry(bt: Stripe.BalanceTransaction, attributed: boolean): LedgerEntry {
  return {
    id: bt.id,
    type: bt.type,
    reporting_category: bt.reporting_category,
    source: typeof bt.source === "string" ? bt.source : (bt.source?.id ?? null),
    amount: bt.amount,
    fee: bt.fee,
    net: bt.net,
    currency: bt.currency,
    exchange_rate: bt.exchange_rate ?? null,
    status: bt.status,
    available_on_iso: iso(bt.available_on),
    created_iso: iso(bt.created),
    fee_details: bt.fee_details.map((f) => ({ type: f.type, amount: f.amount, description: f.description ?? null })),
    description: bt.description ?? null,
    attributed,
  };
}

export function totals(entries: LedgerEntry[]): LedgerTotals {
  const sum = (xs: LedgerEntry[]) => xs.reduce((n, e) => n + e.net, 0);
  const currencies = [...new Set(entries.map((e) => e.currency))];
  return {
    net: sum(entries),
    // Stripe processing fees net of any fee refunds, as reported on the balance transactions.
    stripeFees: entries.reduce((n, e) => n + e.fee_details.filter((f) => f.type === "stripe_fee").reduce((m, f) => m + f.amount, 0), 0),
    pendingNet: sum(entries.filter((e) => e.status === "pending")),
    availableNet: sum(entries.filter((e) => e.status === "available")),
    currencies,
    currencyConversion: entries.some((e) => e.exchange_rate !== null) || currencies.some((c) => c !== "pln"),
  };
}

async function listSince(stripe: Stripe, since: number, options?: Stripe.RequestOptions) {
  const out: Stripe.BalanceTransaction[] = [];
  for await (const bt of stripe.balanceTransactions.list({ created: { gte: since }, limit: 100 }, options)) out.push(bt);
  return out;
}

/** IDs of balance transactions already present in the window before a run starts. */
export async function snapshotLedger(stripe: Stripe, connectedAccountId: string, since: number): Promise<Set<string>> {
  const [p, c] = await Promise.all([listSince(stripe, since), listSince(stripe, since, { stripeAccount: connectedAccountId })]);
  return new Set([...p, ...c].map((bt) => bt.id));
}

/**
 * Collects balance transactions created since `since` (unix seconds) on the platform and
 * on the connected account. The connected account is dedicated to the lab and scenarios
 * run sequentially, so everything on it since `since` belongs to the run. Platform
 * entries are attributed by source ID; anything else is reported separately.
 * `exclude` holds balance transactions that existed before the run (created in the same
 * seconds by a previous scenario), which are never counted.
 * Balance transactions are written asynchronously, so listing repeats until stable.
 */
export async function collectLedger(
  stripe: Stripe,
  { connectedAccountId, since, sources, exclude }: { connectedAccountId: string; since: number; sources: Set<string>; exclude: Set<string> },
): Promise<Ledger> {
  let platform: Stripe.BalanceTransaction[] = [];
  let connected: Stripe.BalanceTransaction[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const [p, c] = (await Promise.all([listSince(stripe, since), listSince(stripe, since, { stripeAccount: connectedAccountId })])).map(
      (list) => list.filter((bt) => !exclude.has(bt.id)),
    );
    const stable = attempt > 0 && p.length === platform.length && c.length === connected.length;
    platform = p;
    connected = c;
    if (stable) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  const chronological = (a: LedgerEntry, b: LedgerEntry) => a.created_iso.localeCompare(b.created_iso) || a.id.localeCompare(b.id);
  const platformEntries = platform.map((bt) => toEntry(bt, sources.has(toEntry(bt, false).source ?? ""))).sort(chronological);
  const connectedEntries = connected.map((bt) => toEntry(bt, true)).sort(chronological);
  const attributed = platformEntries.filter((e) => e.attributed);
  return {
    platform: attributed,
    connected: connectedEntries,
    unattributedPlatform: platformEntries.filter((e) => !e.attributed),
    platformTotals: totals(attributed),
    connectedTotals: totals(connectedEntries),
  };
}

async function listBySource(stripe: Stripe, source: string, options?: Stripe.RequestOptions) {
  const out: Stripe.BalanceTransaction[] = [];
  for await (const bt of stripe.balanceTransactions.list({ source, limit: 100 }, options)) out.push(bt);
  return out;
}

/**
 * Ledger for one payment, attributed strictly by source object IDs on both sides, so it
 * stays correct when several payments are in flight (unlike the time-window collector
 * used by the sequential Phase 2 scenarios).
 *
 * Observed: the balance transaction `source` filter does not return every entry that
 * reports that source (e.g. seller-side `adjustment` entries for application fee refunds
 * report source = py_… but are not returned by source=py_…). The seller side is therefore
 * listed by time (since the PaymentIntent was created) and matched on the reported source.
 */
export async function ledgerBySources(
  stripe: Stripe,
  {
    platformSources,
    connectedSources,
    connectedAccountId,
    since,
  }: { platformSources: string[]; connectedSources: string[]; connectedAccountId: string | null; since: number },
): Promise<Pick<Ledger, "platform" | "connected" | "platformTotals" | "connectedTotals">> {
  const chronological = (a: LedgerEntry, b: LedgerEntry) => a.created_iso.localeCompare(b.created_iso) || a.id.localeCompare(b.id);
  const unique = (bts: Stripe.BalanceTransaction[]) => [...new Map(bts.map((bt) => [bt.id, bt])).values()];
  const platform = unique((await Promise.all(platformSources.map((s) => listBySource(stripe, s)))).flat())
    .map((bt) => toEntry(bt, true))
    .sort(chronological);
  const sellerSources = new Set(connectedSources);
  const connected = connectedAccountId && sellerSources.size
    ? (await listSince(stripe, since, { stripeAccount: connectedAccountId }))
        .map((bt) => toEntry(bt, true))
        .filter((e) => e.source !== null && sellerSources.has(e.source))
        .sort(chronological)
    : [];
  return { platform, connected, platformTotals: totals(platform), connectedTotals: totals(connected) };
}
