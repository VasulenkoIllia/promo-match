import { describe, expect, it } from "vitest";
import { attemptAddress, attemptKey, clientAddress, CLOUDFLARE_RANGES, isCloudflare } from "./client-ip.js";

const EDGE = "162.158.10.20";
const EDGE_V6 = "2a06:98c0:3600::103";

const request = (ip: string, headers: Record<string, string | string[]> = {}) => ({ ip, headers });

describe("isCloudflare", () => {
  it("knows the first address of every published range", () => {
    for (const range of CLOUDFLARE_RANGES) expect(isCloudflare(range.split("/")[0] ?? "")).toBe(true);
  });

  it("holds the edges of a range, not the addresses next to it", () => {
    expect(isCloudflare("173.245.63.255")).toBe(true);
    expect(isCloudflare("173.245.64.0")).toBe(false);
    expect(isCloudflare("173.245.47.255")).toBe(false);
    expect(isCloudflare("2a06:98c7:ffff::1")).toBe(true);
    expect(isCloudflare("2a06:98c8::1")).toBe(false);
  });

  it("matches an IPv4-mapped IPv6 address against the IPv4 ranges", () => {
    expect(isCloudflare("::ffff:104.16.0.1")).toBe(true);
    expect(isCloudflare("::ffff:203.0.113.5")).toBe(false);
  });

  it("refuses private addresses, a zone id and what is not an address", () => {
    for (const address of ["172.18.0.5", "127.0.0.1", "::1", "2606:4700::1%eth0", "162.158.0.1:443", "", "cloudflare"]) {
      expect(isCloudflare(address)).toBe(false);
    }
  });
});

describe("clientAddress", () => {
  it("takes CF-Connecting-IP from a Cloudflare edge, trimmed", () => {
    expect(clientAddress(request(EDGE, { "cf-connecting-ip": " 203.0.113.5 " }))).toBe("203.0.113.5");
    expect(clientAddress(request(EDGE_V6, { "cf-connecting-ip": "2001:db8::7" }))).toBe("2001:db8::7");
    expect(clientAddress(request(`::ffff:${EDGE}`, { "cf-connecting-ip": "203.0.113.5" }))).toBe("203.0.113.5");
  });

  it("ignores the header from anyone else: a request straight to the server counts by its own address", () => {
    expect(clientAddress(request("203.0.113.9", { "cf-connecting-ip": "198.51.100.1" }))).toBe("203.0.113.9");
    expect(clientAddress(request("172.18.0.5", { "cf-connecting-ip": "198.51.100.1" }))).toBe("172.18.0.5");
  });

  it("keeps the edge when the header is missing or is not one address", () => {
    expect(clientAddress(request(EDGE))).toBe(EDGE);
    for (const claimed of ["", "unknown", "203.0.113.5, 198.51.100.1", "203.0.113.5:80", "fe80::1%eth0"]) {
      expect(clientAddress(request(EDGE, { "cf-connecting-ip": claimed }))).toBe(EDGE);
    }
  });

  it("takes the first of a repeated header", () => {
    expect(clientAddress(request(EDGE, { "cf-connecting-ip": ["203.0.113.5", "198.51.100.1"] }))).toBe("203.0.113.5");
  });
});

describe("attemptKey", () => {
  it("counts IPv4 as it is, and a mapped IPv4 as the IPv4", () => {
    expect(attemptKey("203.0.113.5")).toBe("203.0.113.5");
    expect(attemptKey("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(attemptKey("::FFFF:203.0.113.5")).toBe("203.0.113.5");
  });

  it("counts every IPv6 address of one /64 as one caller", () => {
    const key = "2001:db8:1:2::/64";
    expect(attemptKey("2001:db8:1:2::1")).toBe(key);
    expect(attemptKey("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).toBe(key);
    expect(attemptKey("2001:db8:1:2:aaaa::")).toBe(key);
    expect(attemptKey("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
  });

  it("fills the groups that :: stands for, an IPv4 tail taking two", () => {
    expect(attemptKey("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(attemptKey("::1")).toBe("0:0:0:0::/64");
    expect(attemptKey("2001:db8:1::5:6:7")).toBe("2001:db8:1:0::/64");
    expect(attemptKey("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
    expect(attemptKey("1:2:3:4:5::192.0.2.1")).toBe("1:2:3:4::/64");
  });

  it("leaves what is not an address as it is", () => {
    expect(attemptKey("unknown")).toBe("unknown");
    expect(attemptKey("")).toBe("");
  });
});

describe("attemptAddress", () => {
  it("is the /64 of the address behind Cloudflare", () => {
    expect(attemptAddress(request(EDGE, { "cf-connecting-ip": "2001:db8:1:2::9" }))).toBe("2001:db8:1:2::/64");
  });
});
