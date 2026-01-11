import ipaddr from "ipaddr.js";

function normalizeIp(raw: string): string {
  const trimmed = raw.trim();
  const zoneIndex = trimmed.indexOf("%");
  const withoutZone = zoneIndex >= 0 ? trimmed.slice(0, zoneIndex) : trimmed;
  if (withoutZone.startsWith("::ffff:")) {
    return withoutZone.slice(7);
  }
  return withoutZone;
}

export function isIpAllowed(ip: string | undefined, cidrs: string[]): boolean {
  if (!ip) return false;

  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(normalizeIp(ip));
  } catch {
    return false;
  }

  if (addr.kind() === "ipv6") {
    const ipv6 = addr as ipaddr.IPv6;
    if (ipv6.isIPv4MappedAddress()) {
      addr = ipv6.toIPv4Address();
    }
  }

  for (const cidr of cidrs) {
    try {
      const [range, prefix] = ipaddr.parseCIDR(cidr);
      let target: ipaddr.IPv4 | ipaddr.IPv6 = addr;
      if (target.kind() === "ipv6" && range.kind() === "ipv4") {
        const ipv6 = target as ipaddr.IPv6;
        if (ipv6.isIPv4MappedAddress()) {
          target = ipv6.toIPv4Address();
        } else {
          continue;
        }
      }
      if (target.kind() !== range.kind()) continue;
      if (target.match([range, prefix])) return true;
    } catch {
      continue;
    }
  }

  return false;
}
