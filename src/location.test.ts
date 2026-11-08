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

const MESSAGE = "PULSE_LOCATION must hold only tab, space or visible ASCII characters";

const envForm = (s: string): string => new TextDecoder().decode(new TextEncoder().encode(s));

const inside = (unit: string): string => `eu${unit}west`;

function assertRefused(value: string, cls: string): void {
  assert.throws(
    () => parseLocation(value),
    (err: unknown) =>
      err instanceof Error && err.message === MESSAGE && !err.message.includes(value),
    `${cls} is refused`,
  );
}

test("location defaults, trimming and length stay compatible", () => {
  assert.equal(parseLocation(undefined), "default");
  assert.equal(parseLocation(""), "default");
  assert.equal(parseLocation(" \t \t "), "default");
  assert.equal(parseLocation("\t Eu-West \t"), "Eu-West");
  assert.equal(parseLocation("a".repeat(64)), "a".repeat(64));
  assert.throws(() => parseLocation("a".repeat(65)), /64 characters/);
  const longWithControl = `${"a".repeat(32)}${String.fromCharCode(1)}${"a".repeat(32)}`;
  assert.throws(
    () => parseLocation(longWithControl),
    (err: unknown) => err instanceof Error && /64 characters/.test(err.message),
    "length message wins over the C0 control message",
  );
});

test("location rejects header-incompatible character classes", () => {
  for (let c = 0; c < 0x20; c++) {
    if (c !== 0x09) assertRefused(inside(String.fromCharCode(c)), "C0 control");
  }
  assertRefused(inside(String.fromCharCode(0x7f)), "delete control");
  for (let c = 0x80; c <= 0xff; c++) {
    assertRefused(inside(String.fromCharCode(c)), "Latin-1");
    assertRefused(envForm(inside(String.fromCharCode(c))), "Latin-1 environment form");
  }
  assertRefused(inside(String.fromCodePoint(0x4e16)), "above Latin-1");
  assertRefused(inside(String.fromCodePoint(0x1f30d)), "supplementary");
  assertRefused(inside(String.fromCharCode(0xd83c)), "lone surrogate");
  assertRefused(inside(String.fromCharCode(0xdf0d)), "lone surrogate");
});

test("location accepts tab, space and visible ASCII unchanged", () => {
  let accepted = 0;
  for (let c = 0; c < 0x80; c++) {
    if (c !== 0x09 && (c < 0x20 || c > 0x7e)) continue;
    const name = inside(String.fromCharCode(c));
    assert.equal(parseLocation(name), name);
    accepted++;
  }
  assert.equal(accepted, 96);
});
