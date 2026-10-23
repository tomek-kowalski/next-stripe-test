import { createOnboardingLink } from "@/lib/lab/connect/account";
import { handleConnect } from "@/lib/lab/connect/route";
import { ConnectedAccountIdSchema } from "@/lib/lab/schemas";
import { z } from "zod";

export async function POST(request: Request, ctx: RouteContext<"/api/lab/connect/accounts/[id]/onboarding-link">) {
  const { id } = await ctx.params;
  return handleConnect(request, z.strictObject({}), async (stripe, _body, origin) => {
    const link = await createOnboardingLink(stripe, ConnectedAccountIdSchema.parse(id), origin);
    return { ok: true, url: link.url, expires_at: link.expires_at };
  });
}
