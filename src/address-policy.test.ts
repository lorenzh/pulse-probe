/* eslint-disable sonarjs/no-hardcoded-ip -- test fixtures for the private-range deny list, never dialed */
import { expect, test } from "bun:test";
import { blockedCategory, blockedReason } from "./address-policy.ts";

const CASES: readonly (readonly [string, string | null])[] = [
  ["9.255.255.255", null],
  ["10.0.0.0", "private"],
  ["10.255.255.255", "private"],
  ["11.0.0.0", null],
  ["172.15.255.255", null],
  ["172.16.0.0", "private"],
  ["172.31.255.255", "private"],
  ["172.32.0.0", null],
  ["192.167.255.255", null],
  ["192.168.0.1", "private"],
  ["192.169.0.0", null],
  ["100.63.255.255", null],
  ["100.64.0.0", "private"],
  ["100.127.255.255", "private"],
  ["100.128.0.0", null],
  ["100.100.100.200", "metadata"],
  ["126.255.255.255", null],
  ["127.0.0.1", "loopback"],
  ["127.255.255.254", "loopback"],
  ["128.0.0.0", null],
  ["169.253.255.255", null],
  ["169.254.0.1", "link-local"],
  ["169.254.169.254", "metadata"],
  ["169.255.0.0", null],
  ["0.0.0.0", "unspecified"],
  ["0.255.255.255", "unspecified"],
  ["1.0.0.0", null],
  ["168.63.129.15", null],
  ["168.63.129.16", "metadata"],
  ["168.63.129.17", null],
  ["::", "unspecified"],
  ["::1", "loopback"],
  ["::2", "reserved"],
  ["::ffff:ffff", "reserved"],
  ["::1:0:0", null],
  ["::ffff:127.0.0.1", "loopback"],
  ["::ffff:7f00:1", "loopback"],
  ["::ffff:10.0.0.1", "private"],
  ["::ffff:169.254.169.254", "metadata"],
  ["::ffff:8.8.8.8", null],
  ["fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", null],
  ["fc00::1", "private"],
  ["fdff:ffff::1", "private"],
  ["fd00:ec2::254", "metadata"],
  ["fe7f:ffff::1", null],
  ["fe80::1", "link-local"],
  ["fe80::1%eth0", "link-local"],
  ["[fe80::1]", "link-local"],
  ["febf:ffff::1", "link-local"],
  ["fec0::1", "private"],
  ["feff::1", "private"],
  ["ff02::1", null],
  ["203.0.113.10", null],
  ["8.8.8.8", null],
  ["2001:db8::1", null],
  ["2606:4700::1111", null],
];

test.each(CASES)("blockedCategory(%p) is %p", (address, expected) => {
  const category: string | null = blockedCategory(address);
  expect(category).toBe(expected);
});

test("blockedReason names the category and the setting", () => {
  expect(blockedReason("loopback", false)).toBe(
    "blocked: loopback address (PULSE_PROBE_BLOCK_PRIVATE_RANGES)",
  );
  expect(blockedReason("private", true)).toBe(
    "redirect blocked: private address (PULSE_PROBE_BLOCK_PRIVATE_RANGES)",
  );
});
