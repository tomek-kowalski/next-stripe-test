const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type GuardRejection = { status: 403 | 404 | 415; message: string };

function hostname(hostHeader: string): string {
  // Keep bracketed IPv6 intact, strip the port otherwise.
  return hostHeader.startsWith("[") ? hostHeader.slice(0, hostHeader.indexOf("]") + 1) : hostHeader.split(":")[0];
}

/** Highest amount (grosze) a single payment may have in public test mode: 500.00 PLN. */
export const PUBLIC_MAX_AMOUNT = 50_000;

/**
 * Public test mode (approved by the owner for the temporary Sandbox): on a Vercel
 * deployment (VERCEL=1) the lab is open to testers without login. Set
 * LAB_PUBLIC_ACCESS=0 on Vercel to lock it again. Still enforced in this mode:
 * Sandbox (test-mode) keys only, money only to the tagged lab account, same-origin
 * JSON for mutations, and PUBLIC_MAX_AMOUNT per payment.
 */
export function isPublicMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL === "1" && env.LAB_PUBLIC_ACCESS !== "0";
}

/**
 * Lab endpoints move (Sandbox) money with the server's secret key, so outside public
 * test mode they are restricted to local development:
 * - disabled entirely outside NODE_ENV=development/test (e.g. `next start`, deployments),
 * - only answered for loopback Host headers (not LAN access to `next dev`),
 * - mutations require a same-origin JSON request, so other websites open in the
 *   browser cannot trigger them (cross-origin JSON POSTs need a CORS preflight we never grant).
 */
export function checkLocalRequest(
  request: Request,
  env: string | undefined = process.env.NODE_ENV,
  publicMode: boolean = isPublicMode(),
): GuardRejection | null {
  // Read the request before anything else: touching request headers marks the route as
  // request-time, so `next build` never prerenders (and caches) a lab route's response.
  const host = request.headers.get("host");
  if (!host) return { status: 403, message: "Brak nagłówka Host." };
  if (!publicMode) {
    if (env !== "development" && env !== "test") {
      return { status: 404, message: "Nie znaleziono" };
    }
    if (!LOOPBACK_HOSTS.has(hostname(host))) {
      return { status: 403, message: "Endpointy laboratorium odpowiadają tylko na żądania do localhost." };
    }
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("origin");
    if (origin !== null) {
      let originHost: string;
      try {
        originHost = new URL(origin).host;
      } catch {
        return { status: 403, message: "Nieprawidłowy nagłówek Origin." };
      }
      if (originHost !== host) {
        return { status: 403, message: "Żądania z innej domeny (cross-origin) są odrzucane." };
      }
    }
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return { status: 415, message: "Operacje zmieniające dane wymagają Content-Type: application/json." };
    }
  }

  return null;
}
