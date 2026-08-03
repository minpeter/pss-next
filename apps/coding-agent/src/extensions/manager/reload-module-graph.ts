import { createRequire, register } from "node:module";
import { sep } from "node:path";

/**
 * Module customization hook that propagates the `pss-extension-update`
 * cache-busting parameter from a parent module to every extension-owned
 * module it imports. Without this, `/reload` would only re-import extension
 * entry points while sibling and helper modules stayed pinned in Node's
 * module cache.
 *
 * Managed extensions live at `<installRoot>/node_modules/<package>`, so the
 * marker follows imports that stay inside the same package (the extension's
 * own helpers) but stops at imports that cross into a different package
 * (real dependencies). Node retains every distinct ESM URL for the process
 * lifetime, so re-versioning dependency graphs on each reload would leak
 * memory; updating a dependency still requires `pss extension update` or a
 * restart.
 *
 * The hook is pass-through for every resolution whose parent does not carry
 * the marker parameter, so regular imports keep their normal behavior.
 */
const HOOK_SOURCE = `
const MARKER = /[?&]pss-extension-update=([^&#]+)/;
const packageRootOf = (url) => {
  const index = url.lastIndexOf("/node_modules/");
  if (index === -1) {
    return;
  }
  const start = index + "/node_modules/".length;
  const segments = url.slice(start).split("/");
  const packageLength = segments[0]?.startsWith("@") ? 2 : 1;
  return url.slice(0, start) + segments.slice(0, packageLength).join("/");
};
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
  const resolvedRoot = packageRootOf(resolved.url);
  if (resolvedRoot !== undefined && resolvedRoot !== packageRootOf(parent)) {
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
  /** Kept for the reload transaction API; CommonJS cache is never mutated. */
  rollback(): void;
}

/**
 * Refuse a live reload when extension-owned CommonJS modules are cached.
 * Evicting process-wide `require.cache` entries can contaminate the still
 * active runtime, so CommonJS changes require a process restart. ESM reload
 * remains supported by the graph-propagation hook above.
 *
 * Pass loose-module directories and managed package roots explicitly;
 * `node_modules` trees nested below a root (real dependencies) are left
 * untouched for the same reasons the ESM hook skips them.
 *
 */
export function beginCommonJsReloadTransaction(
  roots: readonly string[],
  candidateCommonJsPaths: readonly string[] = []
): CommonJsReloadTransaction {
  const require = createRequire(import.meta.url);
  const prefixes = roots.map((root) =>
    root.endsWith(sep) ? root : `${root}${sep}`
  );
  const owned = (key: string): boolean =>
    prefixes.some(
      (prefix) =>
        key.startsWith(prefix) &&
        !key.slice(prefix.length).includes(`${sep}node_modules${sep}`) &&
        !key.slice(prefix.length).startsWith(`node_modules${sep}`)
    );
  for (const key of [
    ...Object.keys(require.cache),
    ...candidateCommonJsPaths,
  ]) {
    if (owned(key)) {
      throw new Error(
        `Extension reload requires a restart because CommonJS module "${key}" is loaded`
      );
    }
  }
  return {
    rollback: () => undefined,
  };
}
