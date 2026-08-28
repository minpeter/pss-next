export const MAX_RETAINED_LATENCY_SAMPLES = 4096;

export function recordRecentLatencySample(
  samples: number[],
  sample: number,
  completed: number
): void {
  if (samples.length < MAX_RETAINED_LATENCY_SAMPLES) {
    samples.push(sample);
    return;
  }
  samples[(completed - 1) % MAX_RETAINED_LATENCY_SAMPLES] = sample;
}

export function mergeRecentLatencySamples(
  existing: readonly number[],
  incoming: readonly number[]
): number[] {
  const combined = [...existing, ...incoming];
  return combined.length <= MAX_RETAINED_LATENCY_SAMPLES
    ? combined
    : combined.slice(-MAX_RETAINED_LATENCY_SAMPLES);
}
