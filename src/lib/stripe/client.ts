import Stripe from "stripe";

export class LabConfigError extends Error {
  readonly name = "LabConfigError";
}

let client: Stripe | undefined;

/**
 * Server-only Stripe client. Refuses to start without a test-mode (Sandbox) key,
 * so a live key can never be used by this lab even if it is configured by mistake.
 */
export function getStripe(): Stripe {
  if (typeof window !== "undefined") {
    throw new LabConfigError("Klient Stripe z kluczem tajnym nie może działać w przeglądarce.");
  }
  if (client) return client;

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new LabConfigError(
      "Brak STRIPE_SECRET_KEY. Ustaw klucz Sandbox (sk_test_… lub rk_test_…) w .env.local.",
    );
  }
  if (!/^(sk|rk)_test_/.test(key)) {
    throw new LabConfigError("STRIPE_SECRET_KEY musi być kluczem testowym (Sandbox, test-mode). Klucze produkcyjne są odrzucane.");
  }

  client = new Stripe(key, {
    // No silent SDK retries: the lab must show the real outcome of every request.
    // Retries are done explicitly with a caller-supplied idempotency key.
    maxNetworkRetries: 0,
    appInfo: { name: "stripe-connect-lab" },
  });
  return client;
}

export const STRIPE_API_VERSION = Stripe.API_VERSION;
export const STRIPE_SDK_VERSION = Stripe.PACKAGE_VERSION;
