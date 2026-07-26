import { createRequire, register } from "node:module";
import { sep } from "node:path";

/**
 * Module customization hook that propagates the `pss-extension-update`
 * cache-busting parameter from a parent module to every extension-owned
 * module it imports. Without this, `/reload` would only re-import extension
 * entry points while sibling and helper modules stayed pinned in Node's
 * module cache.
 *
 * Dependencies under `node_modules` keep their stable URLs: Node retains
 * every distinct ESM URL for the process lifetime, so re-versioning large
 * dependency graphs on each reload would leak memory. Reload therefore
 * refreshes extension-owned files only; updating a dependency still requires
 * `pss extension update` or a restart.
 *
 * The hook is pass-through for every resolution whose parent does not carry
 * the marker parameter, so regular imports keep their normal behavior.
 */
const HOOK_SOURCE = `
const MARKER = /[?&]pss-extension-update=([^&#]+)/;
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  const parent = context.parentURL;
  if (typeof parent !== "string") {
    return resolved;
  }
  const match = MARKER.exec(parent);
  if (match === null) {
    return resolved;
  }
  if (!resolved.url.startsWith("file:")) {
    return resolved;
  }
  if (resolved.url.includes("/node_modules/")) {
    return resolved;
  }
  if (MARKER.test(resolved.url)) {
    return resolved;
  }
  const separator = resolved.url.includes("?") ? "&" : "?";
  return {
    ...resolved,
    url: resolved.url + separator + "pss-extension-update=" + match[1],
  };
}
`;

let registered = false;

/**
 * Install the graph-propagation hook once per process. Called lazily from
 * cache-busted extension imports so normal startups never pay for it.
 */
export function ensureReloadModuleGraphHooks(): void {
  if (registered) {
    return;
  }
  registered = true;
  if (typeof register !== "function") {
    return;
  }
  register(`data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`);
}

export interface CommonJsReloadTransaction {
  /** Restore the pre-reload cache so a failed reload cannot hand the live
   * runtime freshly re-executed CommonJS helper instances. */
  rollback(): void;
}

/**
 * Evict extension-owned CommonJS modules cached under the given roots so
 * cache-busted ESM imports re-execute `.cjs` helpers, snapshotting the
 * evicted entries first. The ESM resolve hook cannot reach the CommonJS
 * cache because Node keys it by filesystem path rather than URL.
 *
 * Entries under `node_modules` are left untouched for the same reasons the
 * ESM hook skips them.
 */
export function beginCommonJsReloadTransaction(
  roots: readonly string[]
): CommonJsReloadTransaction {
  const require = createRequire(import.meta.url);
  const prefixes = roots.map((root) =>
    root.endsWith(sep) ? root : `${root}${sep}`
  );
  const owned = (key: string): boolean =>
    !key.includes(`${sep}node_modules${sep}`) &&
    prefixes.some((prefix) => key.startsWith(prefix));
  const snapshot = new Map<string, NodeJS.Module>();
  for (const key of Object.keys(require.cache)) {
    if (!owned(key)) {
      continue;
    }
    const entry = require.cache[key];
    if (entry !== undefined) {
      snapshot.set(key, entry);
    }
    delete require.cache[key];
  }
  return {
    rollback: () => {
      for (const key of Object.keys(require.cache)) {
        if (owned(key)) {
          delete require.cache[key];
        }
      }
      for (const [key, entry] of snapshot) {
        require.cache[key] = entry;
      }
    },
  };
}
