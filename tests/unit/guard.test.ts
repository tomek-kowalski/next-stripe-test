import { describe, expect, it } from "vitest";
import { checkLocalRequest, isPublicMode } from "@/lib/lab/guard";

const post = (headers: Record<string, string>) =>
  new Request("http://localhost:3000/api/lab/payment-intents", { method: "POST", headers });

describe("checkLocalRequest", () => {
  it("is disabled outside development/test", () => {
    expect(checkLocalRequest(post({ host: "localhost:3000", "content-type": "application/json" }), "production")?.status).toBe(404);
  });

  it("accepts a same-origin JSON POST on loopback hosts", () => {
    for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
      expect(checkLocalRequest(post({ host, origin: `http://${host}`, "content-type": "application/json" }), "development")).toBeNull();
    }
  });

  it("rejects non-loopback hosts", () => {
    expect(checkLocalRequest(post({ host: "192.168.1.20:3000", "content-type": "application/json" }), "development")?.status).toBe(403);
    expect(checkLocalRequest(post({ host: "localhost.evil.com", "content-type": "application/json" }), "development")?.status).toBe(403);
  });

  it("rejects cross-origin mutations", () => {
    const req = post({ host: "localhost:3000", origin: "https://evil.example", "content-type": "application/json" });
    expect(checkLocalRequest(req, "development")?.status).toBe(403);
  });

  it("rejects non-JSON mutations (simple-request CSRF)", () => {
    expect(checkLocalRequest(post({ host: "localhost:3000", "content-type": "text/plain" }), "development")?.status).toBe(415);
  });

  it("allows GET without content-type", () => {
    const get = new Request("http://localhost:3000/api/lab/config", { headers: { host: "localhost:3000" } });
    expect(checkLocalRequest(get, "development")).toBeNull();
  });

  describe("public test mode (Vercel)", () => {
    const host = "next-stripe-test.vercel.app";

    it("is on only on Vercel and can be locked with LAB_PUBLIC_ACCESS=0", () => {
      expect(isPublicMode({ VERCEL: "1" })).toBe(true);
      expect(isPublicMode({ VERCEL: "1", LAB_PUBLIC_ACCESS: "0" })).toBe(false);
      expect(isPublicMode({})).toBe(false);
    });

    it("answers same-origin JSON requests on the deployment host in production", () => {
      const req = post({ host, origin: `https://${host}`, "content-type": "application/json" });
      expect(checkLocalRequest(req, "production", true)).toBeNull();
    });

    it("still rejects cross-origin and non-JSON mutations", () => {
      expect(checkLocalRequest(post({ host, origin: "https://evil.example", "content-type": "application/json" }), "production", true)?.status).toBe(403);
      expect(checkLocalRequest(post({ host, "content-type": "text/plain" }), "production", true)?.status).toBe(415);
    });

    it("keeps production locked when public mode is off", () => {
      expect(checkLocalRequest(post({ host, "content-type": "application/json" }), "production", false)?.status).toBe(404);
    });
  });
});
