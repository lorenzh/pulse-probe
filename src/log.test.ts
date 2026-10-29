import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger, parseLogLevel } from "./log.ts";

test("parseLogLevel defaults to info and rejects unknown values", () => {
  assert.equal(parseLogLevel(undefined), "info");
  assert.equal(parseLogLevel(" "), "info");
  assert.equal(parseLogLevel("debug"), "debug");
  assert.throws(() => parseLogLevel("loud"), /PULSE_LOG_LEVEL must be one of/);
});

test("logger writes JSON lines with ISO time and level, and filters by level", () => {
  const lines: string[] = [];
  const logger = createLogger({
    level: "info",
    now: () => 0,
    write: (_l, line) => lines.push(line),
  });
  logger.debug("hidden");
  logger.warn("careful", { check: "home", level: "spoofed" });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] ?? ""), {
    time: "1970-01-01T00:00:00.000Z",
    level: "warn",
    msg: "careful",
    check: "home",
  });
});
