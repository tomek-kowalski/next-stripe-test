import { connection } from "next/server";
import { checkLocalRequest } from "@/lib/lab/guard";
import type { LabConfig } from "@/lib/lab/types";
import { getStripe, STRIPE_API_VERSION, STRIPE_SDK_VERSION } from "@/lib/stripe/client";

export async function GET(request: Request) {
  await connection();
  const rejection = checkLocalRequest(request);
  if (rejection) return Response.json({ message: rejection.message }, { status: rejection.status });

  const versions = { apiVersion: STRIPE_API_VERSION, sdkVersion: STRIPE_SDK_VERSION };
  let body: LabConfig;
  try {
    const stripe = getStripe();
    try {
      const account = await stripe.accounts.retrieveCurrent();
      body = {
        ok: true,
        mode: "test",
        ...versions,
        account: {
          id: account.id,
          country: account.country ?? null,
          default_currency: account.default_currency ?? null,
          display_name: account.settings?.dashboard?.display_name ?? null,
        },
        accountError: null,
      };
    } catch (error) {
      // A restricted key may lack permission to read the account; payments can still work.
      body = { ok: true, mode: "test", ...versions, account: null, accountError: (error as Error).message };
    }
  } catch (error) {
    body = { ok: false, message: (error as Error).message, ...versions };
  }
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
