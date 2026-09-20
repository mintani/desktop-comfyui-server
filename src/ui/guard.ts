/**
 * What stands between the management UI and the rest of the machine.
 *
 * Binding to 127.0.0.1 is not on its own a defence. A page the user happens to
 * visit can make their browser send requests to this server, and a domain that
 * resolves to 127.0.0.1 can talk to it as same-origin. Since this UI can start a
 * process on the machine, both matter. Three checks, cheapest first:
 *
 * 1. Host — only IP literals and `localhost`, which is what stops a rebound
 *    domain name from reaching the API at all.
 * 2. Origin / Sec-Fetch-Site — a cross-site request is refused, reads included:
 *    a cross-site `<img>` pointed at `/api/output` would otherwise learn which
 *    files exist. Requests with no origin at all (curl, scripts, the desktop
 *    shell) are allowed through, because they cannot be a browser being used
 *    against its owner.
 * 3. Token — off unless `UI_TOKEN` is set. This is the one to turn on before
 *    putting the UI on a network.
 *
 * These apply to `/api/*`. The page itself is static markup with nothing in it,
 * so it is served without them; every request it then makes is checked.
 */

import { timingSafeEqual } from "node:crypto";
import { UI_TOKEN } from "../config";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/**
 * Where the page keeps the token once it has been handed over. `HttpOnly`
 * keeps it out of reach of anything running in the page, and `SameSite=Strict`
 * keeps the browser from attaching it to a request another site started.
 */
export const SESSION_COOKIE = "ui_token";

/** A year. The desktop app rotates the token every launch regardless. */
const SESSION_MAX_AGE_S = 365 * 24 * 60 * 60;

/** IPv4 / IPv6 literals, which a rebound domain name can never be. */
function isIpLiteral(hostname: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  return hostname.startsWith("[") && hostname.endsWith("]");
}

function hostAllowed(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return LOOPBACK.has(hostname) || isIpLiteral(hostname);
}

/**
 * A browser tells us where the request came from. Same origin is fine; a
 * different one is not. `Sec-Fetch-Site: none` means the user typed the address
 * or opened a bookmark, which is also fine.
 */
function originAllowed(req: Request, url: URL): boolean {
  const site = req.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") return false;

  const origin = req.headers.get("Origin");
  if (!origin) return true;

  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

/** Constant time, so a wrong token cannot be found one character at a time. */
function tokensMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/**
 * The header is how scripts and the desktop shell send it. The cookie is how
 * the page sends it, set once by `/api/session` — an `<img src>` cannot carry a
 * header, and a token in the URL would end up in history.
 */
function tokenAccepted(req: Request): boolean {
  if (!UI_TOKEN) return true;

  const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (bearer && tokensMatch(bearer, UI_TOKEN)) return true;

  const cookie = cookieValue(req, SESSION_COOKIE);
  return Boolean(cookie && tokensMatch(cookie, UI_TOKEN));
}

/** The `Set-Cookie` value that hands the page its token. */
export function sessionCookie(): string {
  return (
    `${SESSION_COOKIE}=${encodeURIComponent(UI_TOKEN)}; Path=/; HttpOnly; SameSite=Strict;` +
    ` Max-Age=${SESSION_MAX_AGE_S}`
  );
}

/** A refusal, or null to let the request through. */
export function authorise(req: Request): Response | null {
  const url = new URL(req.url);

  if (!hostAllowed(url)) {
    return Response.json({ error: "host not allowed" }, { status: 403 });
  }

  if (!originAllowed(req, url)) {
    return Response.json({ error: "cross-site request refused" }, { status: 403 });
  }

  if (!tokenAccepted(req)) {
    return Response.json({ error: "a token is required" }, { status: 401 });
  }

  return null;
}
