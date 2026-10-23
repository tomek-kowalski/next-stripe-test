import { handleConnect } from "@/lib/lab/connect/route";
import { getPaymentDetails } from "@/lib/lab/details";
import { PaymentIntentIdSchema } from "@/lib/lab/schemas";

// Read-only; refuses PaymentIntents not created by the lab (403) before returning any detail.
export async function GET(request: Request, ctx: RouteContext<"/api/lab/payment-intents/[id]/details">) {
  const { id } = await ctx.params;
  return handleConnect(request, null, (stripe) => getPaymentDetails(stripe, PaymentIntentIdSchema.parse(id)));
}
