import { handleLabOperation } from "@/lib/lab/route";
import { cancelPaymentIntent } from "@/lib/lab/operations";
import { CancelPaymentIntentBodySchema } from "@/lib/lab/schemas";

export async function POST(request: Request, ctx: RouteContext<"/api/lab/payment-intents/[id]/cancel">) {
  const { id } = await ctx.params;
  return handleLabOperation(request, "cancel", { body: CancelPaymentIntentBodySchema, paymentIntentId: id }, (stripe, body, piId) =>
    cancelPaymentIntent(stripe, piId!, body),
  );
}
