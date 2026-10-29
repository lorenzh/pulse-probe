import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReloadMs } from "./reload-interval.ts";

test("defaults to 60000 when unset or blank", () => {
  assert.equal(parseReloadMs(undefined), 60_000);
  assert.equal(parseReloadMs("  "), 60_000);
});

test("accepts an integer of at least 5000", () => {
  assert.equal(parseReloadMs(" 5000 "), 5000);
  assert.equal(parseReloadMs("120000"), 120_000);
});

test("rejects invalid or too low values", () => {
  for (const raw of ["4999", "abc", "1.5e4", "-6000", "6000.5", "0"]) {
    assert.throws(() => parseReloadMs(raw), /PULSE_CHECKS_RELOAD_MS/);
  }
});
