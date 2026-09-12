import { describe, expect, it } from "vitest";
import { validateOutboundUrl } from "@/lib/net/url-safety";

/**
 * Outbound URL validation for the audio proxy. TC-098.
 *
 * Each blocked case here is a real way to reach something the server can see
 * and the internet cannot.
 */
describe("validateOutboundUrl", () => {
  it("allows a public https host", () => {
    const result = validateOutboundUrl("https://download.quranicaudio.com/7/036.mp3");
    expect(result.ok).toBe(true);
  });

  it("refuses plain http", () => {
    // Downgrading would expose the stream, and the proxy has no reason to.
    expect(validateOutboundUrl("http://audio.example.com/1.mp3")).toMatchObject({ ok: false });
  });

  it.each([
    ["file:///etc/passwd"],
    ["gopher://audio.example.com/"],
    ["data:audio/mpeg;base64,AAAA"],
  ])("refuses non-https scheme %s", (url) => {
    expect(validateOutboundUrl(url)).toMatchObject({ ok: false });
  });

  it("refuses the cloud instance metadata endpoint", () => {
    // The regression this module exists for. On AWS, GCP and Azure this
    // address serves instance credentials to anything that can reach it, and
    // the previous hostname regexes did not cover 169.254.0.0/16.
    expect(validateOutboundUrl("https://169.254.169.254/latest/meta-data/")).toMatchObject({ ok: false });
    expect(validateOutboundUrl("https://metadata.google.internal/computeMetadata/v1/")).toMatchObject({ ok: false });
  });

  it.each([
    ["https://127.0.0.1/x.mp3"],
    ["https://localhost/x.mp3"],
    ["https://10.0.0.5/x.mp3"],
    ["https://192.168.1.10/x.mp3"],
    ["https://172.16.4.4/x.mp3"],
    ["https://172.31.255.255/x.mp3"],
    ["https://0.0.0.0/x.mp3"],
  ])("refuses private address %s", (url) => {
    expect(validateOutboundUrl(url)).toMatchObject({ ok: false });
  });

  it("refuses the carrier-grade NAT range used by Tailscale", () => {
    // Relevant here specifically: 100.64.0.0/10 is where a tailnet lives, and
    // phone testing over Tailscale is part of this project's workflow.
    expect(validateOutboundUrl("https://100.82.14.7:3000/x.mp3")).toMatchObject({ ok: false });
  });

  it("allows a public address adjacent to a private range", () => {
    // 172.32.x.x is public; a regex anchored on "172." alone would block it.
    expect(validateOutboundUrl("https://172.32.0.1/x.mp3")).toMatchObject({ ok: true });
    expect(validateOutboundUrl("https://11.0.0.1/x.mp3")).toMatchObject({ ok: true });
  });

  it("blocks octal loopback forms after URL normalization", () => {
    // The URL parser applies WHATWG host parsing before we see the hostname,
    // so "0177.0.0.1" arrives already normalized to "127.0.0.1" — and that is
    // also the address fetch will connect to. Validating the normalized form
    // is what keeps the check and the connection in agreement.
    expect(validateOutboundUrl("https://0177.0.0.1/x.mp3")).toMatchObject({ ok: false });
    expect(validateOutboundUrl("https://0x7f.0.0.1/x.mp3")).toMatchObject({ ok: false });
    // "010.0.0.1" normalizes to the genuinely public 8.0.0.1, so it is allowed.
    // Blocking it would be blocking a real host that nothing can reach anyway.
    expect(validateOutboundUrl("https://010.0.0.1/x.mp3")).toMatchObject({ ok: true });
  });

  it.each([
    ["https://[::1]/x.mp3"],
    ["https://[fc00::1]/x.mp3"],
    ["https://[fe80::1]/x.mp3"],
    ["https://[::ffff:169.254.169.254]/x.mp3"],
  ])("refuses private IPv6 form %s", (url) => {
    expect(validateOutboundUrl(url)).toMatchObject({ ok: false });
  });

  it("refuses a bare internal hostname", () => {
    expect(validateOutboundUrl("https://internal-audio/x.mp3")).toMatchObject({ ok: false });
  });

  it("refuses credentials embedded in the URL", () => {
    expect(validateOutboundUrl("https://user:pass@audio.example.com/x.mp3")).toMatchObject({ ok: false });
  });

  it("refuses a malformed URL", () => {
    expect(validateOutboundUrl("not a url")).toMatchObject({ ok: false });
    expect(validateOutboundUrl("")).toMatchObject({ ok: false });
  });

  describe("with an explicit host allowlist", () => {
    const allowedHosts = ["quranicaudio.com", "verses.quran.foundation"];

    it("allows an exact match and a subdomain", () => {
      expect(validateOutboundUrl("https://quranicaudio.com/a.mp3", { allowedHosts })).toMatchObject({ ok: true });
      expect(validateOutboundUrl("https://download.quranicaudio.com/a.mp3", { allowedHosts })).toMatchObject({ ok: true });
    });

    it("refuses a lookalike host that merely ends with the same letters", () => {
      // "notquranicaudio.com" must not pass a naive endsWith check.
      expect(validateOutboundUrl("https://notquranicaudio.com/a.mp3", { allowedHosts })).toMatchObject({ ok: false });
    });

    it("refuses an otherwise-valid public host that is not listed", () => {
      expect(validateOutboundUrl("https://example.com/a.mp3", { allowedHosts })).toMatchObject({ ok: false });
    });
  });
});
