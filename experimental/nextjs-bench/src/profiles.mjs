export const BENCHMARK_PROFILES = Object.freeze({
  official: Object.freeze({ earlyExit: true, runs: 4 }),
  internal: Object.freeze({ earlyExit: false, runs: 4 }),
});

export function resolveBenchmarkProfile(name) {
  if (!Object.hasOwn(BENCHMARK_PROFILES, name)) {
    throw new Error(
      `Unknown benchmark profile: ${name}. Expected one of: ${Object.keys(BENCHMARK_PROFILES).join(", ")}.`
    );
  }
  return BENCHMARK_PROFILES[name];
}
