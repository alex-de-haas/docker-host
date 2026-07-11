import { describe, expect, it } from "vitest";
import { isPrivateAddress, resolvesToPrivateHost } from "@/lib/private-host";

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "0.0.0.0",
    "100.64.0.1", // CGNAT
    "::1",
    "::",
    "fc00::1", // ULA
    "fd12:3456::1",
    "fe80::1", // link-local
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:10.0.0.1",
    "224.0.0.1", // IPv4 multicast
    "239.255.255.250", // IPv4 multicast (SSDP)
    "240.0.0.1", // IPv4 reserved/experimental
    "255.255.255.255", // broadcast
    "ff02::1", // IPv6 multicast
    "ff00::", // IPv6 multicast base
    "::abcd", // reserved ::/8, not a public host
    "64:ff9b::1.2.3.4", // NAT64 (::/8 reserved high byte)
  ])("treats %s as private", address => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "140.82.121.3", // github
    "172.15.0.1", // just below the 172.16/12 private block
    "172.32.0.1", // just above it
    "2606:4700:4700::1111", // cloudflare v6
  ])("treats %s as public", address => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it("rejects malformed input", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
    expect(isPrivateAddress("999.1.1.1")).toBe(true);
  });
});

describe("resolvesToPrivateHost", () => {
  it("flags private IP literals without a DNS lookup", async () => {
    expect(await resolvesToPrivateHost("127.0.0.1")).toBe(true);
    expect(await resolvesToPrivateHost("169.254.169.254")).toBe(true);
    expect(await resolvesToPrivateHost("::1")).toBe(true);
  });

  it("passes public IP literals", async () => {
    expect(await resolvesToPrivateHost("8.8.8.8")).toBe(false);
  });

  it("treats an unresolvable host as unsafe", async () => {
    expect(await resolvesToPrivateHost("nonexistent.invalid.")).toBe(true);
  });
});
