import { NextRequest, NextResponse } from "next/server";
import { openRound } from "@/lib/quran/round-token";
import { validateOutboundUrl } from "@/lib/net/url-safety";
import { audioHostAllowlist, timeouts } from "@/lib/config/env";
import { badRequest, toErrorResponse, upstreamError } from "@/lib/http/api-error";

export const dynamic = "force-dynamic";

const ROUTE = "api/quran/audio";

/** Response headers worth forwarding. Range support depends on these. */
const PASSTHROUGH_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
] as const;

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get("token") ?? "";
    const round = openRound(token);

    // The URL comes out of an AES-GCM sealed token, so a player cannot inject
    // one. This is the second layer: if an upstream response ever carried an
    // internal address, the proxy would otherwise fetch it from inside the
    // network and stream the result back.
    const safety = validateOutboundUrl(round.audioUrl, { allowedHosts: audioHostAllowlist() });
    if (!safety.ok) throw badRequest(safety.reason);

    const upstreamHeaders: Record<string, string> = {};
    const range = request.headers.get("range");
    // Forwarding Range is what makes seeking work at all. Mobile Safari will
    // not even begin playback of a long file without a 206 response.
    if (range) upstreamHeaders.Range = range;
    // Conditional headers let the browser revalidate a cached chunk instead of
    // re-downloading it, which matters on a phone.
    const ifRange = request.headers.get("if-range");
    if (ifRange) upstreamHeaders["If-Range"] = ifRange;
    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch) upstreamHeaders["If-None-Match"] = ifNoneMatch;

    // The deadline covers connecting and receiving headers only, then it is
    // cleared. Attaching a timeout to the whole request — as an
    // AbortSignal.timeout() passed to fetch does — aborts the *body stream* as
    // well, which silently truncated playback of any chapter longer than the
    // timeout. Al-Baqarah is over two hours.
    const controller = new AbortController();
    const headerDeadline = setTimeout(() => controller.abort(), timeouts().audioHeaderMs);

    let upstream: Response;
    try {
      upstream = await fetch(safety.url.toString(), {
        headers: upstreamHeaders,
        cache: "no-store",
        // The upstream may redirect to a CDN edge. Following is fine: fetch
        // applies the same https requirement, and the final host is still an
        // address we never disclose to the browser.
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw upstreamError("The recitation audio source did not respond in time.");
      }
      throw upstreamError("Could not reach the recitation audio source.", { cause: error });
    } finally {
      clearTimeout(headerDeadline);
    }

    // 304 is a valid, body-less answer to a conditional request.
    if (upstream.status === 304) {
      return new Response(null, { status: 304, headers: copyHeaders(upstream) });
    }

    if (!upstream.ok && upstream.status !== 206) {
      throw upstreamError(`The recitation audio source returned ${upstream.status}.`);
    }

    const headers = copyHeaders(upstream);
    if (!headers.has("content-type")) headers.set("content-type", "audio/mpeg");
    if (!headers.has("accept-ranges")) headers.set("accept-ranges", "bytes");
    // Private, because the URL embeds a round token and a shared cache must
    // never serve one player's audio to another. Short-lived, because the
    // browser re-requesting every seek would make scrubbing unusable on mobile.
    headers.set("cache-control", "private, max-age=300");
    headers.set("x-content-type-options", "nosniff");

    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    return toErrorResponse(error, ROUTE);
  }
}

function copyHeaders(upstream: Response) {
  const headers = new Headers();
  for (const key of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(key);
    if (value) headers.set(key, value);
  }
  return headers;
}

/**
 * Browsers issue HEAD before streaming in some configurations, and Safari uses
 * it to discover Range support. Answering with the same validation path keeps
 * that probe from falling through to a 405.
 */
export async function HEAD(request: NextRequest) {
  const response = await GET(request);
  return new Response(null, { status: response.status, headers: response.headers });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { Allow: "GET, HEAD, OPTIONS" },
  });
}
