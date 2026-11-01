import { test } from "bun:test";
import assert from "node:assert/strict";
import { type Env, StartupError } from "@lorenzh/pulse-kit";
import { loadSettings, type Settings } from "./settings.ts";

const good = { PULSE_PROBE_TOKEN: "tok-secret" };

const noFile = (path: string): string => {
  throw new Error(`unexpected read of ${path}`);
};

function load(env: Env, readFile: (path: string) => string = noFile): Settings {
  return loadSettings(env, readFile);
}

test("loadSettings applies the defaults", () => {
  const s = load(good);
  assert.equal(s.apiUrl, "http://localhost:3000");
  assert.equal(s.location, "default");
  assert.equal(s.logLevel, "info");
  assert.equal(s.health, undefined);
  assert.equal(s.bufferMaxResults, 10_000);
  assert.equal(s.bufferMaxAgeMs, 3_600_000);
});

test("loadSettings reads the buffer settings", () => {
  const s = load({
    ...good,
    PULSE_BUFFER_MAX_RESULTS: "5",
    PULSE_BUFFER_MAX_AGE_MS: "2147483647",
  });
  assert.equal(s.bufferMaxResults, 5);
  assert.equal(s.bufferMaxAgeMs, 2_147_483_647);
});

for (const [name, env] of [
  ["PULSE_PROBE_TOKEN", {}],
  ["PULSE_LOCATION", { ...good, PULSE_LOCATION: "x".repeat(65) }],
  ["PULSE_CHECKS_RELOAD_MS", { ...good, PULSE_CHECKS_RELOAD_MS: "10" }],
  ["PULSE_BUFFER_MAX_RESULTS", { ...good, PULSE_BUFFER_MAX_RESULTS: "0" }],
  ["PULSE_BUFFER_MAX_AGE_MS", { ...good, PULSE_BUFFER_MAX_AGE_MS: "2147483648" }],
  ["PULSE_LOG_LEVEL", { ...good, PULSE_LOG_LEVEL: "loud" }],
  ["PULSE_HEALTH_PORT", { ...good, PULSE_HEALTH_PORT: "abc" }],
] as const) {
  test(`loadSettings gives one StartupError line for a bad ${name}`, () => {
    assert.throws(
      () => load(env),
      (err: unknown) =>
        err instanceof StartupError &&
        err.message.includes(name) &&
        !err.message.includes("\n") &&
        !err.message.includes("tok-secret"),
    );
  });
}

test("loadSettings reads the health listener with the default host", () => {
  assert.deepEqual(load({ ...good, PULSE_HEALTH_PORT: "9100" }).health, {
    port: 9100,
    host: "127.0.0.1",
  });
  assert.deepEqual(load({ ...good, PULSE_HEALTH_PORT: "0", PULSE_HEALTH_HOST: "0.0.0.0" }).health, {
    port: 0,
    host: "0.0.0.0",
  });
});

for (const value of ["bogus", "", "  ", "file:///x", "https://u:p@x"]) {
  test(`loadSettings rejects PULSE_API_URL=${JSON.stringify(value)} naming the variable`, () => {
    assert.throws(
      () => load({ ...good, PULSE_API_URL: value }),
      (err: unknown) =>
        err instanceof StartupError &&
        err.message.includes("PULSE_API_URL") &&
        !err.message.includes("\n"),
    );
  });
}

test("loadSettings removes the trailing slash of PULSE_API_URL", () => {
  assert.equal(load({ ...good, PULSE_API_URL: "https://api:3000/" }).apiUrl, "https://api:3000");
});

test("loadSettings reads the token from PULSE_PROBE_TOKEN_FILE through the reader", () => {
  const s = load({ PULSE_PROBE_TOKEN_FILE: "/run/secrets/t" }, (path) =>
    path === "/run/secrets/t" ? "  tok-file\n" : "",
  );
  assert.equal(s.token, "tok-file");
});

for (const [label, env, readFile, expected] of [
  [
    "both token variables",
    { PULSE_PROBE_TOKEN: "tok-secret", PULSE_PROBE_TOKEN_FILE: "/t" },
    noFile,
    "set only one of PULSE_PROBE_TOKEN and PULSE_PROBE_TOKEN_FILE",
  ],
  ["no token variable", {}, noFile, "PULSE_PROBE_TOKEN or PULSE_PROBE_TOKEN_FILE must be set"],
  [
    "an empty token file",
    { PULSE_PROBE_TOKEN_FILE: "/t" },
    () => " \n",
    "PULSE_PROBE_TOKEN_FILE=/t: file is empty",
  ],
] as const) {
  test(`loadSettings gives one StartupError line for ${label}`, () => {
    assert.throws(
      () => load(env, readFile),
      (err: unknown) => err instanceof StartupError && err.message === expected,
    );
  });
}

test("PULSE_BUFFER_MAX_RESULTS above 2147483647 names the count limit", () => {
  assert.throws(
    () => load({ ...good, PULSE_BUFFER_MAX_RESULTS: "2147483648" }),
    (err: unknown) =>
      err instanceof StartupError &&
      err.message === "PULSE_BUFFER_MAX_RESULTS: must be a positive integer up to 2147483647",
  );
});

for (const [value, expected] of [
  ["true", true],
  ["1", true],
  [" true ", true],
  ["false", false],
  ["0", false],
  ["", false],
  [undefined, false],
] as const) {
  test(`PULSE_PROBE_BLOCK_PRIVATE_RANGES=${JSON.stringify(value)} gives ${expected}`, () => {
    const env = value === undefined ? good : { ...good, PULSE_PROBE_BLOCK_PRIVATE_RANGES: value };
    assert.equal(load(env).blockPrivateRanges, expected);
  });
}

for (const value of ["TRUE", "yes", "on", "2"]) {
  test(`PULSE_PROBE_BLOCK_PRIVATE_RANGES=${value} is a StartupError`, () => {
    assert.throws(
      () => load({ ...good, PULSE_PROBE_BLOCK_PRIVATE_RANGES: value }),
      (err: unknown) =>
        err instanceof StartupError &&
        err.message === "PULSE_PROBE_BLOCK_PRIVATE_RANGES: must be true, false, 1 or 0",
    );
  });
}

test("loadSettings reads PULSE_PROBE_HEADER_HOSTS and defaults to no bindings", () => {
  assert.equal(load(good).headerHosts.size, 0);
  const s = load({
    ...good,
    PULSE_PROBE_HEADER_HOSTS:
      '{"PULSE_HEADER_SVC_TOKEN":["svc.example.com","192.0.2.7","[fd00::7]"]}',
  });
  assert.deepEqual(
    [...(s.headerHosts.get("PULSE_HEADER_SVC_TOKEN") ?? [])],
    ["svc.example.com", "192.0.2.7", "[fd00::7]"],
  );
});

test("an invalid PULSE_PROBE_HEADER_HOSTS stops the start without echoing the value", () => {
  for (const [text, message] of [
    ["{", "PULSE_PROBE_HEADER_HOSTS must be a JSON object of PULSE_HEADER_* names to host lists"],
    [
      '{"SVC_TOKEN":["a"]}',
      "PULSE_PROBE_HEADER_HOSTS: key 1 must match ^PULSE_HEADER_[A-Za-z0-9_]{1,115}$",
    ],
    [
      '{"PULSE_HEADER_T":"a"}',
      "PULSE_PROBE_HEADER_HOSTS.PULSE_HEADER_T must be an array of at most 100 hosts",
    ],
    [
      '{"PULSE_HEADER_T":["u@a"]}',
      "PULSE_PROBE_HEADER_HOSTS.PULSE_HEADER_T[0] must be a host name or IP address without scheme, port or path",
    ],
  ] as const) {
    assert.throws(
      () => load({ ...good, PULSE_PROBE_HEADER_HOSTS: text }),
      (err: unknown) =>
        err instanceof StartupError && err.message === message && !err.message.includes(text),
    );
  }
});
