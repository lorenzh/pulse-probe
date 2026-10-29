import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSettings, SettingsError } from "./settings.ts";

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
  test(`loadSettings gives one pulse-probe line for a bad ${name}`, () => {
    assert.throws(
      () => loadSettings(env),
      (err: unknown) =>
        err instanceof SettingsError &&
        err.message.startsWith("pulse-probe: ") &&
        err.message.includes(name) &&
        !err.message.includes("\n") &&
        !err.message.includes("tok-secret"),
    );
  });
}
