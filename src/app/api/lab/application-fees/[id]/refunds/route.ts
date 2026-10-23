import { handleConnect } from "@/lib/lab/connect/route";
import { refundApplicationFee } from "@/lib/lab/financial";
import { ApplicationFeeIdSchema, ApplicationFeeRefundBodySchema } from "@/lib/lab/schemas";

export async function POST(request: Request, ctx: RouteContext<"/api/lab/application-fees/[id]/refunds">) {
  const { id } = await ctx.params;
  return handleConnect(request, ApplicationFeeRefundBodySchema, (stripe, body) =>
    refundApplicationFee(stripe, ApplicationFeeIdSchema.parse(id), body),
  );
}
