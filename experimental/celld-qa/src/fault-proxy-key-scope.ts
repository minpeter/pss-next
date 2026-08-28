export function matchesFaultKey(pattern: string, key: string): boolean {
  return pattern.endsWith("*")
    ? key.startsWith(pattern.slice(0, -1))
    : key === pattern;
}

export function hasMatchingFaultWrite(
  writtenKeys: ReadonlySet<string>,
  generation: number,
  pattern: string
): boolean {
  const generationPrefix = `${generation}:`;
  for (const value of writtenKeys) {
    if (
      value.startsWith(generationPrefix) &&
      matchesFaultKey(pattern, value.slice(generationPrefix.length))
    ) {
      return true;
    }
  }
  return false;
}
