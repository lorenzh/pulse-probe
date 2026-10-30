import { test } from "bun:test";
import assert from "node:assert/strict";
import { parseLocation, userAgent } from "./location.ts";

test("defaults when unset or blank", () => {
  assert.equal(parseLocation(undefined), "default");
  assert.equal(parseLocation(""), "default");
  assert.equal(parseLocation("   "), "default");
});

test("trims the value and keeps case", () => {
  assert.equal(parseLocation("  Eu-West "), "Eu-West");
});

test("accepts 64 characters, rejects 65", () => {
  assert.equal(parseLocation("x".repeat(64)), "x".repeat(64));
  assert.throws(() => parseLocation("x".repeat(65)), /64 characters/);
  assert.equal(parseLocation(` ${"x".repeat(64)} `), "x".repeat(64));
});

test("user agent names the location", () => {
  assert.equal(userAgent("a"), "pulse-probe (a)");
});
