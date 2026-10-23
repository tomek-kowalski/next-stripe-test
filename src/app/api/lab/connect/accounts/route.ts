import type Stripe from "stripe";
import { checkAccountReadiness, isLabAccount, summarizeAccount } from "@/lib/lab/connect/account";
import { handleConnect } from "@/lib/lab/connect/route";

// Read-only list of every connected account the platform can see. Only lab-tagged
// accounts get an Accounts v2 readiness check; only they can ever receive money.
export async function GET(request: Request) {
  return handleConnect(request, null, async (stripe) => {
    const accounts: Stripe.Account[] = [];
    for await (const account of stripe.accounts.list({ limit: 100 })) accounts.push(account);
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      accounts: await Promise.all(
        accounts.map(async (a) => ({
          ...summarizeAccount(a),
          created_iso: a.created ? new Date(a.created * 1000).toISOString() : null,
          readiness: isLabAccount(a) ? await checkAccountReadiness(stripe, a.id) : null,
        })),
      ),
    };
  });
}
