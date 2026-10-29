import assert from "node:assert/strict";
import { test } from "node:test";
import type { Check, Result } from "@lorenzh/pulse-contract";
import { createMetrics } from "./metrics.ts";

const check: Check = {
  id: "home",
  name: "Home",
  url: "https://user:pw@example.com/secret?token=abc",
  intervalMs: 1000,
  keyword: "hidden-keyword",
};

function result(status: Result["status"], latencyMs: number): Result {
  return {
    checkId: "home",
    timestamp: 0,
    status,
    statusCode: 200,
    latencyMs,
    reason: null,
    location: "default",
    attempts: 1,
  };
}

test("metrics render the series without URL, keyword or credentials", () => {
  const m = createMetrics();
  m.setChecks([check]);
  m.recordResult(result("up", 120));
  m.recordResult(result("down", 3000));
  m.recordPost("home", "ok");
  m.recordPost("home", "error");
  m.recordPost("home", "ok");
  const text = m.render();
  assert.match(text, /^pulse_up 1$/m);
  assert.match(text, /^pulse_probe_checks_configured 1$/m);
  assert.match(text, /pulse_probe_check_status\{check="home",state="down"\} 1/);
  assert.match(text, /pulse_probe_check_status\{check="home",state="up"\} 0/);
  assert.match(text, /duration_seconds_bucket\{check="home",le="0.25"\} 1/);
  assert.match(text, /duration_seconds_bucket\{check="home",le="\+Inf"\} 2/);
  assert.match(text, /duration_seconds_sum\{check="home"\} 3.12/);
  assert.match(text, /posted_total\{check="home",outcome="ok"\} 2/);
  assert.match(text, /posted_total\{check="home",outcome="error"\} 1/);
  for (const secret of ["example.com", "pw", "hidden-keyword", "token=abc"]) {
    assert.ok(!text.includes(secret), secret);
  }
});

test("metrics drop the series of removed checks and escape labels", () => {
  const m = createMetrics();
  m.setChecks([{ ...check, id: 'a"b' }, check]);
  m.recordResult(result("up", 1));
  m.recordPost("home", "ok");
  assert.match(m.render(), /check="a\\"b"/);
  m.setChecks([{ ...check, id: 'a"b' }]);
  const text = m.render();
  assert.ok(!text.includes('check="home"'));
  assert.match(text, /^pulse_probe_checks_configured 1$/m);
});
