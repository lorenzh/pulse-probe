import assert from "node:assert/strict";
import { test } from "node:test";
import { parseToken } from "./token.ts";

test("rejects a missing or blank token", () => {
  assert.throws(() => parseToken(undefined), /PULSE_PROBE_TOKEN/);
  assert.throws(() => parseToken(""), /PULSE_PROBE_TOKEN/);
  assert.throws(() => parseToken("   "), /PULSE_PROBE_TOKEN/);
});

test("trims a valid token", () => {
  assert.equal(parseToken("  abc123  "), "abc123");
});
