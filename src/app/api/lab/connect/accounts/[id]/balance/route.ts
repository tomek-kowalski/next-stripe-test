import type Stripe from "stripe";
import { retrieveLabAccount } from "@/lib/lab/connect/account";
import { handleConnect } from "@/lib/lab/connect/route";
import { ConnectedAccountIdSchema } from "@/lib/lab/schemas";

const pln = (entries: Stripe.Balance.Available[] | Stripe.Balance.Pending[]) =>
  entries.filter((e) => e.currency === "pln").reduce((n, e) => n + e.amount, 0);

// Balances are shown for the lab account (and the platform) only.
export async function GET(request: Request, ctx: RouteContext<"/api/lab/connect/accounts/[id]/balance">) {
  const { id } = await ctx.params;
  return handleConnect(request, null, async (stripe) => {
    const accountId = ConnectedAccountIdSchema.parse(id);
    await retrieveLabAccount(stripe, accountId);
    const [seller, platform] = await Promise.all([stripe.balance.retrieve({}, { stripeAccount: accountId }), stripe.balance.retrieve()]);
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      seller: { accountId, pending: pln(seller.pending), available: pln(seller.available) },
      platform: { pending: pln(platform.pending), available: pln(platform.available) },
    };
  });
}
