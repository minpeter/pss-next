const MAX_REPETITIONS = 100;

export function parseRuntimeBlockRepetitions(value: string): number {
  const repetitions = Number(value);
  if (
    !Number.isSafeInteger(repetitions) ||
    repetitions <= 0 ||
    repetitions > MAX_REPETITIONS
  ) {
    throw new TypeError(`Invalid runtime block-time repetitions: ${value}`);
  }
  return repetitions;
}
