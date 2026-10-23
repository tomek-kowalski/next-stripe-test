import { retrieveLabAccount, summarizeAccount } from "@/lib/lab/connect/account";
import { handleConnect } from "@/lib/lab/connect/route";
import { ConnectedAccountIdSchema } from "@/lib/lab/schemas";

// Read-only inspection works for any connected account; mutations require a lab account.
export async function GET(request: Request, ctx: RouteContext<"/api/lab/connect/accounts/[id]">) {
  const { id } = await ctx.params;
  return handleConnect(request, null, async (stripe) => {
    const account = await retrieveLabAccount(stripe, ConnectedAccountIdSchema.parse(id), { requireLab: false });
    return { ok: true, requestId: account.lastResponse?.requestId ?? null, status: summarizeAccount(account), raw: account };
  });
}
