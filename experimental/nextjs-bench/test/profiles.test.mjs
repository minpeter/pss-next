import assert from "node:assert/strict";
import test from "node:test";
import { resolveBenchmarkProfile } from "../src/profiles.mjs";

const unknownProfilePattern = /Unknown benchmark profile/u;

test("official profile matches the public Next.js scoring protocol", () => {
  assert.deepEqual(resolveBenchmarkProfile("official"), {
    earlyExit: true,
    runs: 4,
  });
});

test("internal profile preserves every attempt for pass-rate analysis", () => {
  assert.deepEqual(resolveBenchmarkProfile("internal"), {
    earlyExit: false,
    runs: 4,
  });
  assert.throws(
    () => resolveBenchmarkProfile("unknown"),
    unknownProfilePattern
  );
});

test("inherited property names are rejected as unknown profiles", () => {
  assert.throws(
    () => resolveBenchmarkProfile("__proto__"),
    unknownProfilePattern
  );
  assert.throws(
    () => resolveBenchmarkProfile("constructor"),
    unknownProfilePattern
  );
});
