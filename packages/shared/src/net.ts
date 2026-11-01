import dns from "node:dns/promises";
import net from "node:net";

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}

export function cidrContains(cidr: string, ip: string): boolean {
  const [range, bitsStr] = cidr.split("/");
  const v = net.isIP(range);
  let addr = ip;
  if (addr.startsWith("::ffff:") && net.isIPv4(addr.slice(7))) addr = addr.slice(7);
  if (v === 4) {
    if (!net.isIPv4(addr)) return false;
    const bits = bitsStr === undefined ? 32 : Number(bitsStr);
    if (bits === 0) return true;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipv4ToInt(addr) & mask) === (ipv4ToInt(range) & mask);
  }
  if (v === 6) {
    if (!net.isIPv6(addr)) return false;
    const bits = bitsStr === undefined ? 128 : Number(bitsStr);
    const a = expand6(addr), b = expand6(range);
    for (let i = 0; i < 128; i++) {
      if (i >= bits) return true;
      const bitA = (a[i >> 4] >> (15 - (i & 15))) & 1;
      const bitB = (b[i >> 4] >> (15 - (i & 15))) & 1;
      if (bitA !== bitB) return false;
    }
    return true;
  }
  return false;
}

function expand6(ip: string): number[] {
  let [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  // embedded IPv4
  const last = (t.length ? t : h)[(t.length ? t : h).length - 1];
  const arr = t.length ? t : h;
  if (last && net.isIPv4(last)) {
    const n = ipv4ToInt(last);
    arr.splice(arr.length - 1, 1, ((n >>> 16) & 0xffff).toString(16), (n & 0xffff).toString(16));
  }
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  const parts = [...h, ...Array(fill).fill("0"), ...t];
  return parts.map((p) => parseInt(p || "0", 16));
}

export const PRIVATE_CIDRS = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
  "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4",
  "::1/128", "::/128", "fc00::/7", "fe80::/10", "ff00::/8",
];

/** Default networks considered "trusted LAN" for Xtream/M3U access. */
export const DEFAULT_TRUSTED_CIDRS = [
  "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16",
  "::1/128", "fc00::/7", "fe80::/10",
];

export const isPrivateAddress = (ip: string) => PRIVATE_CIDRS.some((c) => cidrContains(c, ip));
export const ipAllowed = (ip: string, cidrs: string[]) => cidrs.some((c) => cidrContains(c, ip));

export class UnsafeUrlError extends Error {}

/** SSRF guard for generic URLs: http(s) only, no credentials, resolves to public addresses only. */
export async function assertPublicHttpUrl(raw: string, lookup = dns.lookup): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new UnsafeUrlError("Invalid URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UnsafeUrlError("Only http and https URLs are allowed");
  if (u.username || u.password) throw new UnsafeUrlError("URLs with credentials are not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local"))
    throw new UnsafeUrlError("Internal hostnames are not allowed");
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const a of addrs as Array<{ address: string }>) {
    if (isPrivateAddress(a.address)) throw new UnsafeUrlError("URL resolves to a private or internal address");
  }
  return u;
}

/** Hostname allowlist check (exact or subdomain). */
export function hostAllowed(hostname: string, allow: string[]): boolean {
  const h = hostname.toLowerCase();
  return allow.some((a) => h === a || h.endsWith("." + a));
}
