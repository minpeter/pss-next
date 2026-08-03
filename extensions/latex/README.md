# `@minpeter/pss-extension-latex`

Official LaTeX display renderer for the PSS coding-agent TUI.

The package contributes assistant output instructions and a fallback renderer
for Markdown display math. It requires no browser, system packages, system
fonts, or external executables: MathJax SVG generation, bundled font loading,
and resvg WebAssembly rasterization run in a persistent, killable Node worker.
The worker has conservative Node heap and stack limits and each render has a
10-second timeout; timeout, abort, or worker failure terminates it and falls
back to source, while the next render starts a fresh worker. These are Node
worker heap/time limits, not hard CPU or OS address-space limits. Bundled Noto
fonts include localized Japanese, Korean, Simplified Chinese, and Traditional
Chinese faces as well as Arabic, Hebrew, Devanagari, and Thai.

```ts
import latexExtension from "@minpeter/pss-extension-latex";
```

The coding-agent includes this package by default. Third-party assistant
renderers can replace it only through an explicit `{ override: true }`
registration.

Complete `$$ ... $$` and `\[ ... \]` display blocks are rendered on terminals
with Kitty graphics support and cached under `$XDG_CACHE_HOME/pss/latex`.
Malformed formulas, emoji, and TeX macros that can inject HTML attributes or
styles fall back to their original Markdown. Rendering performs no subprocess,
filesystem input from TeX, or network access and applies bounded SVG/PNG byte,
dimension, pixel, and queue limits. The same bundled pipeline works on Linux,
macOS, and Windows wherever Node.js and Kitty graphics are available.
