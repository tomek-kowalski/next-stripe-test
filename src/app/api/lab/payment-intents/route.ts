import { handleLabOperation } from "@/lib/lab/route";
import { createPaymentIntent } from "@/lib/lab/operations";
import { CreatePaymentIntentBodySchema } from "@/lib/lab/schemas";

export async function POST(request: Request) {
  return handleLabOperation(request, "create", { body: CreatePaymentIntentBodySchema }, (stripe, body) =>
    createPaymentIntent(stripe, body),
  );
}
