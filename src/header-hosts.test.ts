import { test } from "bun:test";
import assert from "node:assert/strict";
import { StartupError } from "@lorenzh/pulse-kit";
import { canonicalHost, isBound, parseHeaderHosts } from "./header-hosts.ts";

test("isBound matches the canonical host exactly", () => {
  const hosts = parseHeaderHosts('{"PULSE_HEADER_T":["api.example.com"]}');
  for (const url of [
    "https://api.example.com/x",
    "http://API.Example.COM:8443/",
    "https://api.example.com./",
  ]) {
    assert.equal(isBound(hosts, "PULSE_HEADER_T", url), true, url);
  }
  for (const url of [
    "https://evil-api.example.com/",
    "https://api.example.com.evil.net/",
    "https://sub.api.example.com/",
    "https://api.example.co/",
    "https://127.0.0.1/",
    "not a url",
  ]) {
    assert.equal(isBound(hosts, "PULSE_HEADER_T", url), false, url);
  }
  assert.equal(isBound(hosts, "PULSE_HEADER_OTHER", "https://api.example.com/"), false);
});

test("an empty list, an empty setting or no setting binds no host", () => {
  for (const text of ['{"PULSE_HEADER_T":[]}', "", undefined]) {
    assert.equal(isBound(parseHeaderHosts(text), "PULSE_HEADER_T", "https://a.test/"), false);
  }
});

test("entries are normalized like URL hosts", () => {
  const ipv4 = parseHeaderHosts('{"PULSE_HEADER_T":["127.1"]}');
  assert.equal(isBound(ipv4, "PULSE_HEADER_T", "http://127.0.0.1/"), true);
  const ipv6 = parseHeaderHosts('{"PULSE_HEADER_T":["[fd00::7]","svc.example.com."]}');
  assert.equal(isBound(ipv6, "PULSE_HEADER_T", "https://[fd00::7]:81/"), true);
  assert.equal(isBound(ipv6, "PULSE_HEADER_T", "http://svc.example.com/"), true);
  assert.equal(canonicalHost("http://[::1]/"), "[::1]");
});

const objectMessage =
  "PULSE_PROBE_HEADER_HOSTS must be a JSON object of PULSE_HEADER_* names to host lists";
const keyMessage = "PULSE_PROBE_HEADER_HOSTS: key 1 must match ^PULSE_HEADER_[A-Za-z0-9_]{1,115}$";
const arrayMessage =
  "PULSE_PROBE_HEADER_HOSTS.PULSE_HEADER_T must be an array of at most 100 hosts";
const entryMessage =
  "PULSE_PROBE_HEADER_HOSTS.PULSE_HEADER_T[0] must be a host name or IP address without scheme, port or path";

const invalid: [string, string][] = [
  ["{", objectMessage],
  ["[]", objectMessage],
  ["null", objectMessage],
  ['"x"', objectMessage],
  ['{"SVC_TOKEN":["a"]}', keyMessage],
  ['{"PULSE_HEADER_":["a"]}', keyMessage],
  ['{"PULSE_HEADER_T":"a"}', arrayMessage],
  [JSON.stringify({ PULSE_HEADER_T: Array.from({ length: 101 }, () => "a.test") }), arrayMessage],
  ...[
    "api.example.com:443",
    "https://a",
    "a/b",
    "*.example.com",
    "u@a",
    "::1",
    "",
    "a".repeat(254),
    5,
    "a b",
    "a%41",
  ].map((entry): [string, string] => [JSON.stringify({ PULSE_HEADER_T: [entry] }), entryMessage]),
  // 20 + 65514 + 3 = 65537 bytes.
  [
    `{"PULSE_HEADER_T":["${"a".repeat(65_514)}"]}`,
    "PULSE_PROBE_HEADER_HOSTS must be at most 65536 bytes",
  ],
];

test("an invalid setting throws StartupError with a fixed message", () => {
  for (const [text, message] of invalid) {
    assert.throws(
      () => parseHeaderHosts(text),
      (err: unknown) => err instanceof StartupError && err.message === message,
      text.slice(0, 60),
    );
  }
});
