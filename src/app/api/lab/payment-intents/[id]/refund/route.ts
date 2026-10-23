import { handleConnect } from "@/lib/lab/connect/route";
import { refundPayment } from "@/lib/lab/financial";
import { PaymentIntentIdSchema, RefundBodySchema } from "@/lib/lab/schemas";

export async function POST(request: Request, ctx: RouteContext<"/api/lab/payment-intents/[id]/refund">) {
  const { id } = await ctx.params;
  return handleConnect(request, RefundBodySchema, (stripe, body) => refundPayment(stripe, PaymentIntentIdSchema.parse(id), body));
}
