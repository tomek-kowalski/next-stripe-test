import { connection } from "next/server";
import { checkLocalRequest, isPublicMode, PUBLIC_MAX_AMOUNT } from "@/lib/lab/guard";
import type { LabConfig } from "@/lib/lab/types";
import { getStripe, STRIPE_API_VERSION, STRIPE_SDK_VERSION } from "@/lib/stripe/client";

export async function GET(request: Request) {
  await connection();
  const rejection = checkLocalRequest(request);
  if (rejection) return Response.json({ ok: false, kind: "forbidden", message: rejection.message }, { status: rejection.status });

  const versions = { apiVersion: STRIPE_API_VERSION, sdkVersion: STRIPE_SDK_VERSION };
  const publicMode = isPublicMode();
  const mode = { publicMode, maxAmount: publicMode ? PUBLIC_MAX_AMOUNT : 1_000_000 };
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
        ...mode,
      };
    } catch (error) {
      // A restricted key may lack permission to read the account; payments can still work.
      body = { ok: true, mode: "test", ...versions, account: null, accountError: (error as Error).message, ...mode };
    }
  } catch (error) {
    body = { ok: false, message: (error as Error).message, ...versions };
  }
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
