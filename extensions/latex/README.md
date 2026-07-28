# `@minpeter/pss-extension-latex`

Official LaTeX display renderer for the PSS coding-agent TUI.

The package contributes assistant output instructions and a fallback renderer
for Markdown display math. Native rendering is fail-closed and runs only on
Linux when both Bubblewrap and `prlimit` are available.

```ts
import latexExtension from "@minpeter/pss-extension-latex";
```

The coding-agent includes this package by default. Third-party assistant
renderers can replace it only through an explicit `{ override: true }`
registration.
