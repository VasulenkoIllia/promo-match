// The caller's address for the per-address limits of signing in and of the links' pages. On the server the chain is
// Cloudflare, Traefik, this app (docs/deployment.md, «Застосунок за Traefik»); the same rule as gps_crm on that host.
import { BlockList, isIP } from "node:net";
import type { FastifyRequest } from "fastify";

// Cloudflare's published ranges (cloudflare.com/ips-v4 and /ips-v6, read 2026-11-07). Hard-coded: a fetch at start would
// let somebody else's website stop this app, and the list changes once in years.
export const CLOUDFLARE_RANGES = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
] as const;

// No zone id (fe80::1%eth0), no port, no list: isIP alone lets a zone id through
const ADDRESS_ONLY = /^[0-9a-f:.]+$/i;
const IPV4_MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;
const IPV6_GROUPS = 8;
const NETWORK_GROUPS = 4;
// An IPv4 tail of an IPv6 address (64:ff9b::192.0.2.1) takes two groups
const IPV4_TAIL_GROUPS = 2;

const cloudflare = new BlockList();
for (const range of CLOUDFLARE_RANGES) {
  const [network = "", prefix = ""] = range.split("/");
  cloudflare.addSubnet(network, Number(prefix), network.includes(":") ? "ipv6" : "ipv4");
}

function familyOf(address: string): "ipv4" | "ipv6" | null {
  if (!ADDRESS_ONLY.test(address)) return null;
  const version = isIP(address);
  if (version === 4) return "ipv4";
  return version === 6 ? "ipv6" : null;
}

// BlockList matches an IPv4-mapped IPv6 address (::ffff:104.16.0.1) against the IPv4 ranges too
export function isCloudflare(address: string): boolean {
  const family = familyOf(address);
  return family !== null && cloudflare.check(address, family);
}

// Traefik does not trust X-Forwarded-For from outside (no forwardedHeaders) and puts there the peer it saw, so request.ip
// is a Cloudflare edge, or the caller itself when a request reached the server directly. Cloudflare overwrites
// CF-Connecting-IP, so the header counts only when the peer is one of its edges: anyone else who sends it is counted by
// their own address.
export function clientAddress(request: Pick<FastifyRequest, "ip" | "headers">): string {
  const peer = request.ip;
  if (!isCloudflare(peer)) return peer;
  const claimed = request.headers["cf-connecting-ip"];
  const value = (Array.isArray(claimed) ? claimed[0] : claimed)?.trim();
  return value && familyOf(value) ? value : peer;
}

function groupsOf(part: string): string[] {
  return part === "" ? [] : part.split(":");
}

// A rented server gets a whole /64 of IPv6 and can take a new address for every try, so its network counts as one
// caller. IPv4, a mapped IPv4 and anything that is not an address are counted as they are.
export function attemptKey(address: string): string {
  const mapped = IPV4_MAPPED.exec(address)?.[1];
  if (mapped) return mapped;
  if (familyOf(address) !== "ipv6") return address;
  const [head = "", tail] = address.toLowerCase().split("::");
  const left = groupsOf(head);
  const right = tail === undefined ? [] : groupsOf(tail);
  const rightWidth = right.reduce((width, group) => width + (group.includes(".") ? IPV4_TAIL_GROUPS : 1), 0);
  const groups = tail === undefined
    ? left
    : [...left, ...new Array<string>(IPV6_GROUPS - left.length - rightWidth).fill("0"), ...right];
  const network = groups.slice(0, NETWORK_GROUPS).map((group) => Number.parseInt(group, 16).toString(16));
  return `${network.join(":")}::/64`;
}

// The key of the per-address limits
export function attemptAddress(request: Pick<FastifyRequest, "ip" | "headers">): string {
  return attemptKey(clientAddress(request));
}
