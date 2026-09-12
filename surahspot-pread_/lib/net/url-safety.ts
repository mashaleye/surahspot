/**
 * Outbound URL validation for the audio proxy.
 *
 * The audio URL arrives inside an AES-GCM sealed token, so a player cannot
 * inject one directly. This is the second layer: if a Quran Foundation response
 * ever carried an unexpected address — through a compromise, a misconfigured
 * CDN, or a redirect — the proxy would otherwise fetch it with the server's
 * network position and stream the result back to the browser.
 *
 * The previous check tested four regexes against the hostname and missed the
 * range that matters most in a cloud deployment: 169.254.0.0/16, which holds
 * the AWS, GCP, and Azure instance metadata endpoint at 169.254.169.254. On a
 * VM with an instance role, reaching that endpoint means reading credentials.
 * It also missed 100.64.0.0/10 (carrier-grade NAT, and Tailscale's range —
 * relevant here, since Tailscale is part of the documented phone-testing
 * setup), IPv6 unique-local addresses, and IPv4-mapped IPv6 forms.
 */

export type UrlSafetyResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  // Commonly resolves to 127.0.0.1 and is a standard SSRF bypass.
  "localtest.me",
  "metadata",
  "metadata.google.internal",
]);

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    // Reject "01" and "0x7f" style octets: they parse differently across
    // resolvers and are a classic way to smuggle a loopback address past a
    // string comparison.
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function isPrivateIpv4(octets: number[]) {
  const [a, b] = octets;
  if (a === 0) return true;                                  // 0.0.0.0/8 "this network"
  if (a === 10) return true;                                 // RFC1918
  if (a === 127) return true;                                // loopback
  if (a === 169 && b === 254) return true;                   // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;          // RFC1918
  if (a === 192 && b === 168) return true;                   // RFC1918
  if (a === 192 && b === 0) return true;                     // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true;         // CGNAT / Tailscale
  if (a === 198 && (b === 18 || b === 19)) return true;       // benchmarking
  if (a >= 224) return true;                                 // multicast and reserved
  return false;
}

function normalizeIpv6(host: string) {
  return host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

/**
 * Expand an IPv6 literal to its 16 bytes, or null if it is not one.
 *
 * Written out rather than pattern-matched on the text because the URL parser
 * rewrites what it is given: "[::ffff:169.254.169.254]" comes back as
 * "[::ffff:a9fe:a9fe]". A regex looking for the dotted form would see the hex
 * form and wave the metadata endpoint straight through.
 */
function expandIpv6(host: string): Uint8Array | null {
  const address = normalizeIpv6(host);
  if (!address.includes(":")) return null;

  const [headText, tailText, ...extra] = address.split("::");
  if (extra.length) return null;

  const toGroups = (text: string): number[] | null => {
    if (!text) return [];
    const parts = text.split(":");
    const groups: number[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      // A trailing dotted-quad ("::ffff:1.2.3.4") occupies the final two groups.
      if (part.includes(".")) {
        if (index !== parts.length - 1) return null;
        const octets = parseIpv4(part);
        if (!octets) return null;
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const head = toGroups(headText ?? "");
  const tail = tailText === undefined ? [] : toGroups(tailText);
  if (!head || !tail) return null;

  const hasCompression = tailText !== undefined;
  const total = head.length + tail.length;
  if (hasCompression ? total > 8 : total !== 8) return null;

  const groups = hasCompression
    ? [...head, ...Array(8 - total).fill(0), ...tail]
    : head;

  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = (group >> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function isPrivateIpv6(host: string) {
  const bytes = expandIpv6(host);
  // Anything shaped like IPv6 that will not parse is refused rather than
  // guessed at.
  if (!bytes) return true;

  const leadingZero = bytes.slice(0, 10).every((byte) => byte === 0);

  // :: (unspecified) and ::1 (loopback).
  if (bytes.every((byte) => byte === 0)) return true;
  if (leadingZero && bytes[10] === 0 && bytes[11] === 0) {
    const tail = bytes.slice(12);
    if (tail[0] === 0 && tail[1] === 0 && tail[2] === 0 && tail[3] === 1) return true;
    // IPv4-compatible form still reaches an IPv4 destination.
    return isPrivateIpv4([tail[0], tail[1], tail[2], tail[3]]);
  }

  // IPv4-mapped ::ffff:a.b.c.d — the form that hid 169.254.169.254.
  if (leadingZero && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateIpv4([bytes[12], bytes[13], bytes[14], bytes[15]]);
  }

  // Unique local fc00::/7.
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  // Link-local fe80::/10.
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;

  return false;
}

/**
 * Validate a URL for server-side fetching.
 *
 * `allowedHosts`, when provided, is an exact-or-suffix allowlist: "example.com"
 * matches example.com and cdn.example.com but not notexample.com.
 *
 * Note the limit of any pre-flight check: this validates the address as
 * written, and cannot prevent a hostname that resolves to a public address now
 * and a private one at connect time. Pinning the CDN host through
 * AUDIO_HOST_ALLOWLIST is the defence against that, which is why the option
 * exists.
 */
export function validateOutboundUrl(
  candidate: string,
  options: { allowedHosts?: readonly string[] | null } = {},
): UrlSafetyResult {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "Recitation audio URL is malformed." };
  }

  if (url.protocol !== "https:") {
    return { ok: false, reason: "Recitation audio must be served over https." };
  }

  if (url.username || url.password) {
    return { ok: false, reason: "Recitation audio URL must not carry credentials." };
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname) return { ok: false, reason: "Recitation audio host is missing." };
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: "Recitation audio host is not routable." };
  }

  const ipv4 = parseIpv4(hostname);
  if (ipv4 && isPrivateIpv4(ipv4)) {
    return { ok: false, reason: "Recitation audio host is not routable." };
  }

  // Digits and dots that strict parsing rejected: octal ("0177.0.0.1"),
  // zero-padded, short-form, or out-of-range. Resolvers disagree about these
  // and several of them reach loopback, so none of them are let through.
  if (!ipv4 && /^[\d.]+$/.test(hostname)) {
    return { ok: false, reason: "Recitation audio host is not routable." };
  }

  if (hostname.includes(":") && isPrivateIpv6(hostname)) {
    return { ok: false, reason: "Recitation audio host is not routable." };
  }

  // A bare label with no dot is an internal hostname on most networks.
  if (!ipv4 && !hostname.includes(":") && !hostname.includes(".")) {
    return { ok: false, reason: "Recitation audio host is not routable." };
  }

  const allowedHosts = options.allowedHosts;
  if (allowedHosts?.length) {
    const permitted = allowedHosts.some(
      (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
    );
    if (!permitted) {
      return { ok: false, reason: "Recitation audio host is not permitted." };
    }
  }

  return { ok: true, url };
}
