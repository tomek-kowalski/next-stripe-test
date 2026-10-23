import { handleConnect } from "@/lib/lab/connect/route";
import { createTransfer } from "@/lib/lab/financial";
import { TransferBodySchema } from "@/lib/lab/schemas";

export async function POST(request: Request) {
  return handleConnect(request, TransferBodySchema, (stripe, body) => createTransfer(stripe, body));
}
