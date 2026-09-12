import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouteClient } from "../helpers/route-client";
import { GET as searchRoute } from "@/app/api/quran/search/route";
import { GET as audioRoute, HEAD as audioHead } from "@/app/api/quran/audio/route";
import { GET as healthRoute } from "@/app/api/health/route";
import { POST as roundRoute } from "@/app/api/quran/round/route";
import { sealRound } from "@/lib/quran/round-token";
import { resetCatalogCache } from "@/lib/quran/catalog";
import { resetRoundBuilderCaches } from "@/lib/game/round-builder";

const SEARCH_URL = "http://localhost:3000/api/quran/search";
const AUDIO_URL = "http://localhost:3000/api/quran/audio";

function newClient() {
  resetCatalogCache();
  resetRoundBuilderCaches();
  return new RouteClient();
}

describe("surah search", () => {
  let client: RouteClient;
  beforeEach(() => { client = newClient(); });

  it("finds a Surah by name", async () => {
    // TC-032
    const result = await client.get(searchRoute, `${SEARCH_URL}?query=Baqarah`);
    expect(result.status).toBe(200);
    expect(result.body.surahs.some((surah: any) => surah.id === 2)).toBe(true);
  });

  it("finds a Surah by chapter number", async () => {
    // TC-034
    const result = await client.get(searchRoute, `${SEARCH_URL}?query=2`);
    expect(result.body.surahs.some((surah: any) => surah.id === 2)).toBe(true);
  });

  it("finds a Surah by its translated meaning", async () => {
    // TC-036
    const result = await client.get(searchRoute, `${SEARCH_URL}?query=Cow`);
    expect(result.body.surahs.some((surah: any) => surah.id === 2)).toBe(true);
  });

  it("never returns ayah results that would give away the answer", async () => {
    // TC-037, the leak that matters most. The fixture deliberately returns a
    // verse hit alongside the navigation results; the route must drop it.
    const result = await client.get(searchRoute, `${SEARCH_URL}?query=Kursi`);
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toMatch(/verse/i);
    expect(serialized).not.toMatch(/2:255/);
    expect(serialized).not.toMatch(/ayah/i);
    expect(result.status).toBe(200);
    // Every returned item is a Surah summary and nothing else.
    for (const surah of result.body.surahs) {
      expect(Object.keys(surah).sort()).toEqual([
        "id", "nameArabic", "nameComplex", "nameSimple", "translatedName", "versesCount",
      ]);
    }
  });

  it("returns an empty list for an empty query", async () => {
    const result = await client.get(searchRoute, `${SEARCH_URL}?query=`);
    expect(result.body.surahs).toEqual([]);
  });

  it("rejects an oversized query before calling upstream", async () => {
    // TC-039
    const result = await client.get(searchRoute, `${SEARCH_URL}?query=${"a".repeat(500)}`);
    expect(result.status).toBe(400);
  });

  it("survives characters that would break a naive query builder", async () => {
    for (const query of ["%%%", "'; DROP TABLE--", "<script>", "\u0627\u0644\u0628\u0642\u0631\u0629"]) {
      const result = await client.get(searchRoute, `${SEARCH_URL}?query=${encodeURIComponent(query)}`);
      expect([200, 400]).toContain(result.status);
    }
  });

  it("falls back to the local catalog when upstream search fails", async () => {
    // TC-038: a Search outage must not make the game unanswerable.
    const client = newClient();
    const clientModule = await import("@/lib/quran/client");
    const spy = vi.spyOn(clientModule, "qfSearch").mockRejectedValue(new Error("Search is down"));

    try {
      const result = await client.get(searchRoute, `${SEARCH_URL}?query=Kawthar`);
      expect(result.status).toBe(200);
      expect(result.body.source).toBe("local");
      expect(result.body.surahs.some((surah: any) => surah.id === 108)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("audio proxy", () => {
  let client: RouteClient;
  const fetchMock = vi.fn();
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    client = newClient();
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function tokenFor(audioUrl: string) {
    return sealRound({
      verseKey: "36:12",
      chapterId: 36,
      reciterId: 7,
      audioUrl,
      attemptsUsed: 0,
      hintPenalty: 0,
      attemptId: "attempt-1",
      roundId: "round-1",
      revision: 0,
      issuedAt: Date.now(),
    });
  }

  it("forwards a Range request and returns 206 with Content-Range", async () => {
    // TC-096: without this, seeking does not work and mobile Safari will not
    // start playback at all.
    fetchMock.mockResolvedValue(
      new Response("audio-bytes", {
        status: 206,
        headers: {
          "content-type": "audio/mpeg",
          "content-range": "bytes 100-199/5000",
          "accept-ranges": "bytes",
          "content-length": "100",
        },
      }),
    );

    const token = tokenFor("https://audio.example.com/7/036.mp3");
    const result = await client.call(audioRoute, `${AUDIO_URL}?token=${encodeURIComponent(token)}`, {
      headers: { range: "bytes=100-199" },
    });

    expect(result.status).toBe(206);
    expect(result.response.headers.get("content-range")).toBe("bytes 100-199/5000");
    expect(result.response.headers.get("accept-ranges")).toBe("bytes");
    expect(fetchMock.mock.calls[0][1].headers.Range).toBe("bytes=100-199");
  });

  it("sets a private, short-lived cache header", async () => {
    // The URL embeds a round token, so a shared cache must never hold it —
    // but re-fetching on every seek makes scrubbing unusable on a phone.
    fetchMock.mockResolvedValue(new Response("bytes", { status: 200, headers: { "content-type": "audio/mpeg" } }));
    const token = tokenFor("https://audio.example.com/7/036.mp3");
    const result = await client.get(audioRoute, `${AUDIO_URL}?token=${encodeURIComponent(token)}`);
    expect(result.response.headers.get("cache-control")).toBe("private, max-age=300");
  });

  it("does not disclose the upstream URL", async () => {
    fetchMock.mockResolvedValue(new Response("bytes", { status: 200 }));
    const token = tokenFor("https://audio.example.com/7/036.mp3");
    const result = await client.get(audioRoute, `${AUDIO_URL}?token=${encodeURIComponent(token)}`);
    const headers = JSON.stringify(Object.fromEntries(result.response.headers));
    expect(headers).not.toContain("audio.example.com");
    expect(headers).not.toContain("036");
  });

  it("refuses a token whose sealed URL points at the metadata endpoint", async () => {
    // TC-098. Reaching this address from a cloud VM means reading credentials.
    const token = tokenFor("https://169.254.169.254/latest/meta-data/iam/");
    const result = await client.get(audioRoute, `${AUDIO_URL}?token=${encodeURIComponent(token)}`);
    expect(result.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "http://audio.example.com/a.mp3",
    "https://127.0.0.1/a.mp3",
    "https://192.168.0.5/a.mp3",
  ])("refuses sealed URL %s without contacting it", async (audioUrl) => {
    const token = tokenFor(audioUrl);
    const result = await client.get(audioRoute, `${AUDIO_URL}?token=${encodeURIComponent(token)}`);
    expect(result.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a tampered token", async () => {
    // TC-097
    const token = tokenFor("https://audio.example.com/7/036.mp3");
    const raw = Buffer.from(token, "base64url");
    raw[raw.length - 3] ^= 0xff;
    const result = await client.get(
      audioRoute,
      `${AUDIO_URL}?token=${encodeURIComponent(raw.toString("base64url"))}`,
    );
    expect(result.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a missing token", async () => {
    const result = await client.get(audioRoute, AUDIO_URL);
    expect(result.status).toBe(400);
  });

  it("reports an upstream failure as a gateway error, not a crash", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 503 }));
    const token = tokenFor("https://audio.example.com/7/036.mp3");
    const result = await client.get(audioRoute, `${AUDIO_URL}?token=${encodeURIComponent(token)}`);
    expect(result.status).toBe(502);
  });

  it("passes a conditional request through and returns 304 with no body", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 304, headers: { etag: '"abc"' } }));
    const token = tokenFor("https://audio.example.com/7/036.mp3");
    const result = await client.call(audioRoute, `${AUDIO_URL}?token=${encodeURIComponent(token)}`, {
      headers: { "if-none-match": '"abc"' },
    });
    expect(result.status).toBe(304);
    expect(fetchMock.mock.calls[0][1].headers["If-None-Match"]).toBe('"abc"');
  });

  it("answers HEAD so Safari can probe for Range support", async () => {
    fetchMock.mockResolvedValue(
      new Response("bytes", { status: 200, headers: { "accept-ranges": "bytes" } }),
    );
    const token = tokenFor("https://audio.example.com/7/036.mp3");
    const response = await audioHead(
      new (await import("next/server")).NextRequest(
        new URL(`${AUDIO_URL}?token=${encodeURIComponent(token)}`),
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
  });
});

describe("rate limiting", () => {
  beforeEach(() => {
    process.env.RATE_LIMIT_ENABLED = "true";
    process.env.RATE_LIMIT_ROUND_PER_MINUTE = "3";
  });

  afterEach(() => {
    process.env.RATE_LIMIT_ENABLED = "false";
    delete process.env.RATE_LIMIT_ROUND_PER_MINUTE;
  });

  it("refuses a burst past the budget and says when to retry", async () => {
    const client = newClient();
    const statuses: number[] = [];

    for (let index = 0; index < 5; index += 1) {
      const result = await client.post(roundRoute, "http://localhost:3000/api/quran/round", {
        language: "english",
      });
      statuses.push(result.status);
      if (result.status === 429) {
        expect(result.response.headers.get("Retry-After")).toMatch(/^\d+$/);
        expect(result.body.kind).toBe("rate_limited");
      }
    }

    expect(statuses.filter((status) => status === 200)).toHaveLength(3);
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
  });
});

describe("health endpoint", () => {
  it("reports liveness without touching upstream", async () => {
    const client = newClient();
    const result = await client.get(healthRoute, "http://localhost:3000/api/health");
    expect(result.status).toBe(200);
    expect(result.body.status).toBe("ok");
    expect(result.body.checks.store).toEqual({ backend: "memory", ok: true });
    expect(result.body.checks.catalog).toBeUndefined();
  });

  it("verifies the catalog in deep mode", async () => {
    const client = newClient();
    const result = await client.get(healthRoute, "http://localhost:3000/api/health?deep=1");
    expect(result.status).toBe(200);
    expect(result.body.checks.catalog.ok).toBe(true);
    expect(result.body.checks.catalog.chapters).toBe(114);
  });

  it("does not advertise the deployed version", async () => {
    // An unauthenticated endpoint should not tell a scanner what is running.
    const client = newClient();
    const result = await client.get(healthRoute, "http://localhost:3000/api/health");
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toMatch(/"version"/);
    expect(serialized).not.toMatch(/commit/i);
  });
});
