import { handleConnect } from "@/lib/lab/connect/route";
import { reverseTransfer } from "@/lib/lab/financial";
import { ReversalBodySchema, TransferIdSchema } from "@/lib/lab/schemas";

export async function POST(request: Request, ctx: RouteContext<"/api/lab/transfers/[id]/reversals">) {
  const { id } = await ctx.params;
  return handleConnect(request, ReversalBodySchema, (stripe, body) => reverseTransfer(stripe, TransferIdSchema.parse(id), body));
}
