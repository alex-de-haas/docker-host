import { lookup } from "node:dns/promises";
import net from "node:net";

// SSRF guard for untrusted, catalog-entry-owned URLs (feedsUrl, descriptionUrl). The Marketplace app
// runs inside the Hosty host network and can reach Core and sibling apps, and it returns a fetched
// description body to the admin browser — so an entry pointing at an internal address would be a
// read/exfiltration primitive. Entry URLs are resolved and rejected when they target a
// non-public address. The operator-configured catalog source itself is trusted and is NOT checked
// here (local/dev catalogs are legitimate).
//
// Limitation: this resolves the host and inspects the addresses before the fetch, so a DNS-rebinding
// attacker with a fast-TTL record could still return a public address here and a private one to the
// fetch. Closing that needs a connect-time IP check (custom dispatcher); the pre-resolve check plus
// refusing redirects covers static/literal and ordinary DNS-based SSRF, which is the realistic threat
// for a catalog document.
export async function resolvesToPrivateHost(hostname: string): Promise<boolean> {
  const literalFamily = net.isIP(hostname);
  let addresses: string[];
  if (literalFamily !== 0) {
    addresses = [hostname];
  } else {
    try {
      addresses = (await lookup(hostname, { all: true, verbatim: true })).map(entry => entry.address);
    } catch {
      // Unresolvable host: treat as unsafe so a lookup failure never silently allows the fetch.
      return true;
    }
  }

  return addresses.length === 0 || addresses.some(isPrivateAddress);
}

// True for loopback, link-local (incl. the 169.254.169.254 cloud metadata address), private/ULA,
// unspecified, and IPv4-mapped IPv6 forms of those. Errs toward rejecting anything not clearly public.
export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    return isPrivateIpv4(address);
  }
  if (family === 6) {
    return isPrivateIpv6(address);
  }
  return true;
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = octets;
  return (
    a === 0 || // 0.0.0.0/8 "this host"
    a === 10 || // 10.0.0.0/8 private
    a === 127 || // 127.0.0.0/8 loopback
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local (includes cloud metadata)
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    a >= 224 // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved/experimental (never a public host)
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]; // drop any zone id
  if (normalized === "::1" || normalized === "::") {
    return true;
  }

  // IPv4-mapped/compatible (::ffff:x.x.x.x, ::x.x.x.x): defer to the embedded IPv4 rules.
  const mapped = normalized.match(/(?:^::ffff:|^::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) {
    return isPrivateIpv4(mapped[1]);
  }

  // First 16-bit group value. A leading "::" makes the first segment empty (value 0); a short group
  // like "64" is 0x0064, so parse the group directly rather than right-padding it (which would read
  // "64" as 0x6400 and miss the reserved ::/8 range).
  const head = normalized.split(":")[0] ?? "";
  const prefix = head === "" ? 0 : Number.parseInt(head, 16);
  if (Number.isNaN(prefix)) {
    return true;
  }

  return (
    (prefix & 0xff00) === 0x0000 || // ::/8 reserved (unspecified, IPv4-mapped/compat, NAT64) — no public host
    (prefix & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (prefix & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (prefix & 0xff00) === 0xff00 // ff00::/8 multicast
  );
}
