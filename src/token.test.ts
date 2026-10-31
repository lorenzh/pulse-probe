import { test } from "bun:test";
import assert from "node:assert/strict";
import { StartupError } from "@lorenzh/pulse-kit";
import { readProbeToken } from "./token.ts";

const SENTINEL = "tok-sentinel-481";

class FakeFsError extends Error {
  override name = "FakeFsError";
  code: unknown;
  constructor(message: string, code: unknown) {
    super(message);
    this.code = code;
  }
}

interface FakeReader {
  read: (path: string) => string;
  calls: string[];
}

function reader(content: string): FakeReader {
  const calls: string[] = [];
  return {
    calls,
    read: (path) => {
      calls.push(path);
      return content;
    },
  };
}

function failingReader(err: unknown): FakeReader {
  const calls: string[] = [];
  return {
    calls,
    read: (path) => {
      calls.push(path);
      throw err;
    },
  };
}

function startupMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof StartupError, "expected a StartupError");
    assert.ok(!err.message.includes(SENTINEL), "message holds the token");
    assert.ok(!err.message.includes("\n"), "message has more than one line");
    return err.message;
  }
  assert.fail("expected a throw");
}

test("uses the trimmed PULSE_PROBE_TOKEN and never calls the reader", () => {
  const r = reader("other");
  assert.equal(readProbeToken({ PULSE_PROBE_TOKEN: `  ${SENTINEL}  ` }, r.read), SENTINEL);
  assert.deepEqual(r.calls, []);
});

test("uses the trimmed content of PULSE_PROBE_TOKEN_FILE", () => {
  const r = reader(`  ${SENTINEL}\n`);
  assert.equal(readProbeToken({ PULSE_PROBE_TOKEN_FILE: " /run/secrets/t " }, r.read), SENTINEL);
  assert.deepEqual(r.calls, ["/run/secrets/t"]);
});

test("both set: rejects before any file read", () => {
  const r = reader("other");
  const message = startupMessage(() =>
    readProbeToken({ PULSE_PROBE_TOKEN: SENTINEL, PULSE_PROBE_TOKEN_FILE: "/x" }, r.read),
  );
  assert.equal(message, "set only one of PULSE_PROBE_TOKEN and PULSE_PROBE_TOKEN_FILE");
  assert.deepEqual(r.calls, []);
});

for (const env of [
  {},
  { PULSE_PROBE_TOKEN: "" },
  { PULSE_PROBE_TOKEN: "   " },
  { PULSE_PROBE_TOKEN_FILE: "" },
  { PULSE_PROBE_TOKEN: "  ", PULSE_PROBE_TOKEN_FILE: "" },
]) {
  test(`neither set (${JSON.stringify(env)}): asks for one of the two`, () => {
    const r = reader(SENTINEL);
    assert.equal(
      startupMessage(() => readProbeToken(env, r.read)),
      "PULSE_PROBE_TOKEN or PULSE_PROBE_TOKEN_FILE must be set",
    );
    assert.deepEqual(r.calls, []);
  });
}

test("a blank PULSE_PROBE_TOKEN with a file uses the file", () => {
  const r = reader("tok");
  assert.equal(
    readProbeToken({ PULSE_PROBE_TOKEN: "", PULSE_PROBE_TOKEN_FILE: "/run/secrets/t" }, r.read),
    "tok",
  );
});

for (const content of ["", " \n\t\n"]) {
  test(`file content ${JSON.stringify(content)} is empty`, () => {
    assert.equal(
      startupMessage(() => readProbeToken({ PULSE_PROBE_TOKEN_FILE: "/t" }, reader(content).read)),
      "PULSE_PROBE_TOKEN_FILE=/t: file is empty",
    );
  });
}

test("multi-line content is rejected without printing it", () => {
  for (const content of [`${SENTINEL}\nsecond`, `${SENTINEL}\rsecond`]) {
    const message = startupMessage(() =>
      readProbeToken({ PULSE_PROBE_TOKEN_FILE: "/t" }, reader(content).read),
    );
    assert.equal(message, "PULSE_PROBE_TOKEN_FILE=/t: must hold one line");
    assert.ok(!message.includes("second"));
  }
});

test("a read error with an E code names the path and the code", () => {
  const r = failingReader(new FakeFsError(`ENOENT: ${SENTINEL}`, "ENOENT"));
  assert.equal(
    startupMessage(() => readProbeToken({ PULSE_PROBE_TOKEN_FILE: "/missing" }, r.read)),
    "PULSE_PROBE_TOKEN_FILE=/missing: cannot read (ENOENT)",
  );
});

for (const err of [
  new Error(`read failed: ${SENTINEL}`),
  new FakeFsError(SENTINEL, "not a code"),
  new FakeFsError(SENTINEL, 13),
  SENTINEL,
]) {
  test(`a read error without a usable code (${String(err)}) gives only "cannot read"`, () => {
    assert.equal(
      startupMessage(() =>
        readProbeToken({ PULSE_PROBE_TOKEN_FILE: "/t" }, failingReader(err).read),
      ),
      "PULSE_PROBE_TOKEN_FILE=/t: cannot read",
    );
  });
}

const NOT_PRINTABLE = [
  `${SENTINEL}\u0000x`,
  `${SENTINEL}\tx`,
  `${SENTINEL}\u007f`,
  `${SENTINEL}\ufffd\ufffd`,
  `${SENTINEL}\ufeffx`,
  `${SENTINEL}\u2028x`,
  `${SENTINEL}\u00e9`,
];

for (const content of NOT_PRINTABLE) {
  test(`file content ${JSON.stringify(content)} is rejected as not printable ASCII`, () => {
    assert.equal(
      startupMessage(() => readProbeToken({ PULSE_PROBE_TOKEN_FILE: "/t" }, reader(content).read)),
      "PULSE_PROBE_TOKEN_FILE=/t: must hold printable ASCII",
    );
  });

  test(`PULSE_PROBE_TOKEN ${JSON.stringify(content)} is rejected as not printable ASCII`, () => {
    assert.equal(
      startupMessage(() => readProbeToken({ PULSE_PROBE_TOKEN: content }, reader("x").read)),
      "PULSE_PROBE_TOKEN must hold printable ASCII",
    );
  });
}

test("a token with an inner space and all printable ASCII is accepted", () => {
  const token = "a b~!#$%&'*+-.^_`|0Z";
  assert.equal(readProbeToken({ PULSE_PROBE_TOKEN_FILE: "/t" }, reader(token).read), token);
  assert.equal(readProbeToken({ PULSE_PROBE_TOKEN: token }, reader("x").read), token);
});
