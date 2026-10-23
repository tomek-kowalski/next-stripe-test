import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as create } from "@/app/api/lab/payment-intents/route";
import type { OperationFailure } from "@/lib/lab/types";

const request = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://localhost:3000/api/lab/payment-intents", {
    method: "POST",
    headers: { host: "localhost:3000", "content-type": "application/json", ...headers },
    body,
  });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("POST /api/lab/payment-intents (no Stripe call)", () => {
  it("returns 400 with issues for invalid amounts", async () => {
    const res = await create(request(JSON.stringify({ amount: 12.5, currency: "pln" })));
    const body = (await res.json()) as OperationFailure;
    expect(res.status).toBe(400);
    expect(body.kind).toBe("validation");
    expect(body.issues?.[0].path).toBe("amount");
  });

  it("rejects any currency other than PLN", async () => {
    for (const currency of ["eur", "usd", "PLN"]) {
      const res = await create(request(JSON.stringify({ amount: 5000, currency })));
      const body = (await res.json()) as OperationFailure;
      expect(res.status).toBe(400);
      expect(body.issues?.[0]).toMatchObject({ path: "currency", message: "Obsługiwana jest wyłącznie waluta PLN." });
    }
  });

  it("returns 400 for malformed JSON", async () => {
    const res = await create(request("{not json"));
    expect(res.status).toBe(400);
  });

  it("returns 403 for cross-origin requests", async () => {
    const res = await create(request(JSON.stringify({ amount: 5000, currency: "pln" }), { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
  });

  it("refuses live-mode keys", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "rk_live_notarealkey");
    vi.resetModules();
    const { POST } = await import("@/app/api/lab/payment-intents/route");
    const res = await POST(request(JSON.stringify({ amount: 5000, currency: "pln" })));
    const body = (await res.json()) as OperationFailure;
    expect(res.status).toBe(500);
    expect(body.kind).toBe("config");
    expect(body.message).toMatch(/test-mode/);
  });
});
