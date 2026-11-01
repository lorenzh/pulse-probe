import { test } from "bun:test";
import assert from "node:assert/strict";
import { capReason, quote } from "./reason.ts";

test("capReason keeps 1000 characters and cuts longer text to 999 plus an ellipsis", () => {
  const exact = "x".repeat(1000);
  assert.equal(capReason(exact), exact);
  const long = capReason("y".repeat(1001));
  assert.equal(long, `${"y".repeat(999)}…`);
  assert.equal(long.length, 1000);
  assert.equal(capReason(""), "");
});

test("quote keeps 80 characters and cuts longer text", () => {
  assert.equal(quote("a".repeat(80)), "a".repeat(80));
  assert.equal(quote("a".repeat(81)), `${"a".repeat(80)}…`);
});
