import { handleLabOperation } from "@/lib/lab/route";
import { retrievePaymentIntent } from "@/lib/lab/operations";

export async function GET(request: Request, ctx: RouteContext<"/api/lab/payment-intents/[id]">) {
  const { id } = await ctx.params;
  return handleLabOperation(request, "retrieve", { body: null, paymentIntentId: id }, (stripe, _body, piId) =>
    retrievePaymentIntent(stripe, piId!),
  );
}
