import { describe, expect, it } from "vitest";
import { checkLocalRequest } from "@/lib/lab/guard";

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
});
