import { handleLabOperation } from "@/lib/lab/route";
import { confirmPaymentIntent } from "@/lib/lab/operations";
import { ConfirmPaymentIntentBodySchema } from "@/lib/lab/schemas";

export async function POST(request: Request, ctx: RouteContext<"/api/lab/payment-intents/[id]/confirm">) {
  const { id } = await ctx.params;
  return handleLabOperation(request, "confirm", { body: ConfirmPaymentIntentBodySchema, paymentIntentId: id }, (stripe, body, piId) =>
    confirmPaymentIntent(stripe, piId!, body),
  );
}
