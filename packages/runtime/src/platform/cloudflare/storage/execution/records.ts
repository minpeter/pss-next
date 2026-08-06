export function storeKey(prefix: string, kind: string, id: string): string {
  return `${prefix}:${kind}:${id}`;
}
