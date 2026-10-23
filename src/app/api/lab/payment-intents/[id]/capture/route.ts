import { handleLabOperation } from "@/lib/lab/route";
import { capturePaymentIntent } from "@/lib/lab/operations";
import { CapturePaymentIntentBodySchema } from "@/lib/lab/schemas";

export async function POST(request: Request, ctx: RouteContext<"/api/lab/payment-intents/[id]/capture">) {
  const { id } = await ctx.params;
  return handleLabOperation(request, "capture", { body: CapturePaymentIntentBodySchema, paymentIntentId: id }, (stripe, body, piId) =>
    capturePaymentIntent(stripe, piId!, body),
  );
}
