export const pooled = async <T>(
  thunks: readonly (() => Promise<T>)[],
  width: number,
  onComplete?: (value: T) => Promise<void> | void
): Promise<readonly T[]> => {
  const results = new Array<T>(thunks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < thunks.length) {
      const index = next;
      next += 1;
      const thunk = thunks[index];
      if (thunk !== undefined) {
        const result = await thunk();
        results[index] = result;
        await onComplete?.(result);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(width, thunks.length) }, worker)
  );
  return results;
};
