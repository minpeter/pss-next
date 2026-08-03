import assert from "node:assert/strict";
import test from "node:test";
import { resolveNextVersion, resolveStartsPerMinute } from "../src/config.mjs";

function withoutEnv(name, run) {
  const saved = process.env[name];
  delete process.env[name];
  try {
    run();
  } finally {
    if (saved === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = saved;
    }
  }
}

test("next version defaults to the pinned reproducible canary", () => {
  withoutEnv("PSS_BENCH_NEXT_VERSION", () => {
    assert.equal(resolveNextVersion(), "16.3.0-canary.89");
  });
});

test("blank next version values count as unset", () => {
  withoutEnv("PSS_BENCH_NEXT_VERSION", () => {
    assert.equal(resolveNextVersion(""), "16.3.0-canary.89");
    assert.equal(resolveNextVersion(undefined, "   "), "16.3.0-canary.89");
    assert.equal(resolveNextVersion("", ""), "16.3.0-canary.89");
  });
  assert.equal(resolveNextVersion("", "16.3.0-canary.91"), "16.3.0-canary.91");
});

test("padded next version values are trimmed", () => {
  assert.equal(resolveNextVersion(" 16.3.0-canary.90 "), "16.3.0-canary.90");
  assert.equal(
    resolveNextVersion(undefined, "\t16.3.0-canary.91\n"),
    "16.3.0-canary.91"
  );
});

test("explicit next version overrides the pin", () => {
  assert.equal(resolveNextVersion("16.3.0-canary.90"), "16.3.0-canary.90");
  assert.equal(
    resolveNextVersion(undefined, "16.3.0-canary.91"),
    "16.3.0-canary.91"
  );
  assert.equal(
    resolveNextVersion("16.3.0-canary.90", "16.3.0-canary.91"),
    "16.3.0-canary.90"
  );
});

test("starts-per-minute falls back to a positive default", () => {
  withoutEnv("PSS_BENCH_STARTS_PER_MINUTE", () => {
    assert.equal(resolveStartsPerMinute(undefined), 4);
  });
  assert.equal(resolveStartsPerMinute("0"), 4);
  assert.equal(resolveStartsPerMinute("-3"), 4);
  assert.equal(resolveStartsPerMinute("abc"), 4);
  assert.equal(resolveStartsPerMinute("2.5"), 4);
  assert.equal(resolveStartsPerMinute("10"), 10);
});
