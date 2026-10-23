import { listBookings } from "@/lib/lab/bookings";
import { handleConnect } from "@/lib/lab/connect/route";
import { BookingIdSchema } from "@/lib/lab/schemas";

// Read-only: bookings reconstructed from lab PaymentIntent metadata (Stripe Search API).
export async function GET(request: Request) {
  return handleConnect(request, null, async (stripe) => {
    const id = new URL(request.url).searchParams.get("id");
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      searchMayLag: true,
      bookings: await listBookings(stripe, id ? BookingIdSchema.parse(id) : undefined),
    };
  });
}
