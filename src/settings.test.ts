import { test } from "bun:test";
import assert from "node:assert/strict";
import { StartupError } from "@lorenzh/pulse-kit";
import { loadSettings } from "./settings.ts";

const good = { PULSE_PROBE_TOKEN: "tok-secret" };

test("loadSettings applies the defaults", () => {
  const s = loadSettings(good);
  assert.equal(s.apiUrl, "http://localhost:3000");
  assert.equal(s.location, "default");
  assert.equal(s.logLevel, "info");
  assert.equal(s.health, undefined);
});

for (const [name, env] of [
  ["PULSE_PROBE_TOKEN", {}],
  ["PULSE_LOCATION", { ...good, PULSE_LOCATION: "x".repeat(65) }],
  ["PULSE_CHECKS_RELOAD_MS", { ...good, PULSE_CHECKS_RELOAD_MS: "10" }],
  ["PULSE_LOG_LEVEL", { ...good, PULSE_LOG_LEVEL: "loud" }],
  ["PULSE_HEALTH_PORT", { ...good, PULSE_HEALTH_PORT: "abc" }],
] as const) {
  test(`loadSettings gives one StartupError line for a bad ${name}`, () => {
    assert.throws(
      () => loadSettings(env),
      (err: unknown) =>
        err instanceof StartupError &&
        err.message.includes(name) &&
        !err.message.includes("\n") &&
        !err.message.includes("tok-secret"),
    );
  });
}

test("loadSettings reads the health listener with the default host", () => {
  assert.deepEqual(loadSettings({ ...good, PULSE_HEALTH_PORT: "9100" }).health, {
    port: 9100,
    host: "127.0.0.1",
  });
  assert.deepEqual(
    loadSettings({ ...good, PULSE_HEALTH_PORT: "0", PULSE_HEALTH_HOST: "0.0.0.0" }).health,
    { port: 0, host: "0.0.0.0" },
  );
});

for (const value of ["bogus", "", "  ", "file:///x", "https://u:p@x"]) {
  test(`loadSettings rejects PULSE_API_URL=${JSON.stringify(value)} naming the variable`, () => {
    assert.throws(
      () => loadSettings({ ...good, PULSE_API_URL: value }),
      (err: unknown) =>
        err instanceof StartupError &&
        err.message.includes("PULSE_API_URL") &&
        !err.message.includes("\n"),
    );
  });
}

test("loadSettings removes the trailing slash of PULSE_API_URL", () => {
  assert.equal(
    loadSettings({ ...good, PULSE_API_URL: "https://api:3000/" }).apiUrl,
    "https://api:3000",
  );
});
