import { register } from "node:module";

/**
 * Module customization hook that propagates the `pss-extension-update`
 * cache-busting parameter from a parent module to every module it imports.
 * Without this, `/reload` would only re-import extension entry points while
 * sibling and helper modules stayed pinned in Node's module cache.
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
