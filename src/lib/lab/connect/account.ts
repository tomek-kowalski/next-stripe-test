import type Stripe from "stripe";

/** Every account this lab creates is tagged; nothing else is ever modified or paid out to. */
export const LAB_ACCOUNT_TAG = { lab: "stripe-connect-lab" } as const;

export class NotALabAccountError extends Error {
  readonly name = "NotALabAccountError";
}

export type AccountStatus = {
  id: string;
  isLabAccount: boolean;
  type: string;
  country: string | null;
  default_currency: string | null;
  email: string | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  capabilities: Record<string, string>;
  controller: Stripe.Account.Controller | null;
  requirements: {
    currently_due: string[];
    eventually_due: string[];
    past_due: string[];
    pending_verification: string[];
    disabled_reason: string | null;
    errors: { requirement: string; code: string; reason: string }[];
  };
  external_accounts: { id: string; object: string; country: string | null; currency: string | null; last4: string | null }[];
  /** True when the account can take part in every Phase 2 flow. */
  ready: boolean;
  notReadyReasons: string[];
};

export function isLabAccount(account: Stripe.Account): boolean {
  return account.metadata?.lab === LAB_ACCOUNT_TAG.lab;
}

export function summarizeAccount(account: Stripe.Account): AccountStatus {
  const req = account.requirements;
  const capabilities = Object.fromEntries(Object.entries(account.capabilities ?? {}).map(([k, v]) => [k, String(v)]));
  const notReadyReasons: string[] = [];
  if (!isLabAccount(account)) notReadyReasons.push("konto spoza laboratorium (brak metadata.lab)");
  if (!account.charges_enabled) notReadyReasons.push("charges_enabled = false");
  if (!account.payouts_enabled) notReadyReasons.push("payouts_enabled = false");
  if (capabilities.transfers !== "active") notReadyReasons.push(`transfers capability = ${capabilities.transfers ?? "nie zażądano"}`);
  if (capabilities.card_payments !== "active") notReadyReasons.push(`card_payments capability = ${capabilities.card_payments ?? "nie zażądano"}`);
  if (req?.currently_due?.length) notReadyReasons.push(`requirements.currently_due: ${req.currently_due.join(", ")}`);
  if (req?.past_due?.length) notReadyReasons.push(`requirements.past_due: ${req.past_due.join(", ")}`);
  if (req?.disabled_reason) notReadyReasons.push(`disabled_reason = ${req.disabled_reason}`);
  if (account.default_currency !== "pln") notReadyReasons.push(`default_currency = ${account.default_currency}`);

  return {
    id: account.id,
    isLabAccount: isLabAccount(account),
    type: account.type,
    country: account.country ?? null,
    default_currency: account.default_currency ?? null,
    email: account.email ?? null,
    charges_enabled: account.charges_enabled,
    payouts_enabled: account.payouts_enabled,
    details_submitted: account.details_submitted,
    capabilities,
    controller: account.controller ?? null,
    requirements: {
      currently_due: req?.currently_due ?? [],
      eventually_due: req?.eventually_due ?? [],
      past_due: req?.past_due ?? [],
      pending_verification: req?.pending_verification ?? [],
      disabled_reason: req?.disabled_reason ?? null,
      errors: (req?.errors ?? []).map((e) => ({ requirement: e.requirement, code: e.code, reason: e.reason })),
    },
    external_accounts: (account.external_accounts?.data ?? []).map((x) => ({
      id: x.id,
      object: x.object,
      country: x.country ?? null,
      currency: x.currency ?? null,
      last4: x.last4 ?? null,
    })),
    ready: notReadyReasons.length === 0,
    notReadyReasons,
  };
}

/**
 * Creates a Polish Express connected account and prefills it with Stripe's documented
 * test values. On API 2026-09-30.endive this sandbox rejects `POST /v1/accounts`
 * ("Stripe no longer recommends Accounts v1 for new Connect integrations"), so the
 * account is created with Accounts v2. Its ID (acct_…) works with the v1 payment APIs.
 * Terms of service and the payout bank account are collected by hosted onboarding.
 */
export async function createLabExpressAccount(stripe: Stripe, idempotencyKey: string) {
  const created = await stripe.v2.core.accounts.create(
    {
      display_name: "stripe-connect-lab test seller",
      contact_email: "lab-seller@example.com",
      // Express Dashboard; the platform collects fees (Express pricing) and is liable
      // for negative balances it cannot recover from the account.
      dashboard: "express",
      defaults: {
        currency: "pln",
        locales: ["pl-PL"],
        // Shown to Stripe for underwriting only.
        profile: { product_description: "C2C rental deposits (stripe-connect-lab test seller)" },
        responsibilities: { fees_collector: "application_express", losses_collector: "application" },
      },
      identity: {
        country: "pl",
        entity_type: "individual",
        individual: {
          given_name: "Jenny",
          surname: "Rosen",
          email: "lab-seller@example.com",
          // Stripe test values: DOB 1901-01-01 and address_full_match pass verification.
          date_of_birth: { day: 1, month: 1, year: 1901 },
          address: { line1: "address_full_match", city: "Warszawa", postal_code: "00-001", country: "pl" },
        },
      },
      configuration: {
        // card_payments drives charges_enabled; stripe_transfers is what destination
        // charges and separate transfers actually need.
        merchant: { mcc: "7394", capabilities: { card_payments: { requested: true } } },
        recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } },
      },
      include: ["configuration.merchant", "configuration.recipient", "defaults", "identity", "requirements"],
      metadata: { ...LAB_ACCOUNT_TAG, phase: "2" },
    },
    { idempotencyKey },
  );
  // The v1 view exposes charges_enabled / payouts_enabled / capabilities for summaries.
  const v1 = await stripe.accounts.retrieve(created.id);
  return { v2: created, v1 };
}

export async function retrieveLabAccount(stripe: Stripe, id: string, { requireLab = true } = {}) {
  const account = await stripe.accounts.retrieve(id);
  if (requireLab && !isLabAccount(account)) {
    throw new NotALabAccountError(`Konto ${id} nie zostało utworzone przez laboratorium; nie jest modyfikowane ani używane do płatności.`);
  }
  return account;
}

export async function createOnboardingLink(stripe: Stripe, id: string, origin: string) {
  await retrieveLabAccount(stripe, id);
  return stripe.v2.core.accountLinks.create({
    account: id,
    use_case: {
      type: "account_onboarding",
      account_onboarding: {
        collection_options: { fields: "eventually_due" },
        refresh_url: `${origin}/?onboarding=refresh&account=${id}`,
        return_url: `${origin}/?onboarding=return&account=${id}`,
      },
    },
  });
}

export async function listLabAccounts(stripe: Stripe) {
  const accounts: Stripe.Account[] = [];
  for await (const account of stripe.accounts.list({ limit: 100 })) {
    if (isLabAccount(account)) accounts.push(account);
  }
  return accounts;
}

export type AccountReadiness = {
  accountId: string;
  ready: boolean;
  reasons: string[];
  dashboard: string | null;
  currency: string | null;
  responsibilities: unknown;
  capabilities: { card_payments: string | null; merchant_payouts: string | null; stripe_transfers: string | null; recipient_payouts: string | null };
  requirements: string[];
  requestId: string | null;
};

/** Readiness as reported by Accounts v2; checked before every Phase 2 scenario moves money. */
export async function checkAccountReadiness(stripe: Stripe, id: string): Promise<AccountReadiness> {
  const v2 = await stripe.v2.core.accounts.retrieve(id, {
    include: ["configuration.merchant", "configuration.recipient", "defaults", "requirements"],
  });
  const merchant = v2.configuration?.merchant?.capabilities;
  const recipient = v2.configuration?.recipient?.capabilities;
  const capabilities = {
    card_payments: merchant?.card_payments?.status ?? null,
    merchant_payouts: merchant?.stripe_balance?.payouts?.status ?? null,
    stripe_transfers: recipient?.stripe_balance?.stripe_transfers?.status ?? null,
    recipient_payouts: recipient?.stripe_balance?.payouts?.status ?? null,
  };
  const requirements = (v2.requirements?.entries ?? []).map((e) => `${e.description} (${e.minimum_deadline?.status ?? "?"})`);
  const reasons: string[] = [];
  if (v2.metadata?.lab !== LAB_ACCOUNT_TAG.lab) reasons.push("konto spoza laboratorium (brak metadata.lab)");
  for (const [name, status] of Object.entries(capabilities)) if (status !== "active") reasons.push(`${name} = ${status}`);
  if (requirements.length) reasons.push(`wymagania: ${requirements.join(", ")}`);
  if (v2.defaults?.currency !== "pln") reasons.push(`defaults.currency = ${v2.defaults?.currency}`);
  return {
    accountId: id,
    ready: reasons.length === 0,
    reasons,
    dashboard: v2.dashboard ?? null,
    currency: v2.defaults?.currency ?? null,
    responsibilities: v2.defaults?.responsibilities ?? null,
    capabilities,
    requirements,
    requestId: v2.lastResponse?.requestId ?? null,
  };
}
