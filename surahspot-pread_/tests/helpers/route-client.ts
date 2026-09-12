import { NextRequest } from "next/server";

/**
 * A minimal client for calling route handlers directly.
 *
 * Integration tests import the handlers rather than starting a server, so they
 * run in milliseconds and can assert on the exact Response. What they must not
 * lose in the process is the attempt cookie: it is the mechanism that ties a
 * round token to a browser, and a test that forgot to carry it would pass while
 * the real flow broke.
 *
 * This keeps a cookie jar so a sequence of calls behaves like one browser.
 */
export class RouteClient {
  private cookies = new Map<string, string>();

  get cookieHeader() {
    return Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join("; ");
  }

  getCookie(name: string) {
    return this.cookies.get(name) ?? null;
  }

  setCookie(name: string, value: string) {
    this.cookies.set(name, value);
  }

  clearCookies() {
    this.cookies.clear();
  }

  /** Drop the attempt cookie only, simulating a different browser. */
  forgetAttempt() {
    this.cookies.delete("surahspot_attempt");
  }

  private buildRequest(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    const cookieHeader = this.cookieHeader;
    if (cookieHeader) headers.set("cookie", cookieHeader);
    return new NextRequest(new URL(url, "http://localhost:3000"), {
      ...init,
      headers,
      signal: init.signal ?? undefined,
    });
  }

  private absorbCookies(response: Response) {
    // getSetCookie is the only way to see multiple Set-Cookie headers; the
    // plain .get() collapses them into one comma-joined string.
    const raw = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean) as string[];

    for (const entry of raw) {
      const [pair] = entry.split(";");
      const index = pair.indexOf("=");
      if (index > 0) this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }

  async call<T = any>(
    handler: (request: NextRequest) => Promise<Response> | Response,
    url: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: T; response: Response }> {
    const response = await handler(this.buildRequest(url, init));
    this.absorbCookies(response);

    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? await response.clone().json()
      : (await response.clone().text()) as unknown;

    return { status: response.status, body: body as T, response };
  }

  post<T = any>(
    handler: (request: NextRequest) => Promise<Response> | Response,
    url: string,
    payload: unknown,
  ) {
    return this.call<T>(handler, url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  get<T = any>(handler: (request: NextRequest) => Promise<Response> | Response, url: string) {
    return this.call<T>(handler, url, { method: "GET" });
  }
}
