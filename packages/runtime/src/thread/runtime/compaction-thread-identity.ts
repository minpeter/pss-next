export interface CompactionThreadIdentityParts {
  readonly owner: Readonly<object>;
  readonly threadKey: string;
}

const identityParts = new WeakMap<
  Readonly<object>,
  CompactionThreadIdentityParts
>();

export function createCompactionThreadIdentity(
  owner: Readonly<object>,
  threadKey: string
): Readonly<object> {
  const identity = Object.freeze({});
  identityParts.set(identity, Object.freeze({ owner, threadKey }));
  return identity;
}

export function compactionThreadIdentityParts(
  identity: Readonly<object>
): CompactionThreadIdentityParts {
  const parts = identityParts.get(identity);
  if (parts === undefined) {
    throw new TypeError("Unknown runtime compaction thread identity.");
  }
  return parts;
}
