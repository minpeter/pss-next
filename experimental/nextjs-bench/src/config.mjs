import {
  asSet,
  resolvePositiveInteger,
} from "@minpeter/pss-bench-shared/config";
import { DEFAULT_NEXT_VERSION } from "./constants.mjs";

const DEFAULT_STARTS_PER_MINUTE = 4;

/**
 * Resolution order: explicit CLI flag, then environment, then the pinned
 * default. Never resolves a moving registry tag so campaigns stay
 * reproducible by default.
 */
export function resolveNextVersion(
  requested,
  environment = process.env.PSS_BENCH_NEXT_VERSION
) {
  return asSet(requested) ?? asSet(environment) ?? DEFAULT_NEXT_VERSION;
}

export function resolveStartsPerMinute(
  raw = process.env.PSS_BENCH_STARTS_PER_MINUTE
) {
  return resolvePositiveInteger(raw, DEFAULT_STARTS_PER_MINUTE);
}
