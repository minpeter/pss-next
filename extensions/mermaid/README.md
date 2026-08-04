# `@minpeter/pss-extension-mermaid`

Official Mermaid diagram renderer for the PSS coding-agent TUI.

The package contributes assistant output instructions and a fallback renderer
for ```` ```mermaid ```` fenced code blocks. Following the pi ecosystem's
approach ([`pi-mermaid`](https://github.com/Gurpartap/pi-mermaid)), it renders
diagrams as Unicode box art with
[`beautiful-mermaid`](https://www.npmjs.com/package/beautiful-mermaid): the
original fence source stays visible and the rendered diagram appears directly
below it, as an annotation.

Rendering is synchronous, pure TypeScript, and works in every terminal: no
browser, DOM shim, worker thread, image protocol, disk cache, or network
access. Flowchart, sequence, state, class, ER, and XY-chart diagrams are
supported; other diagram types and malformed sources simply show the original
fence. Unclosed fences while streaming show the source until they complete,
and oversized outputs fall back to the source.

```ts
import mermaidExtension from "@minpeter/pss-extension-mermaid";
```

The coding-agent includes this package by default. It composes with the LaTeX
extension through the assistant-renderer fallback chain: the Mermaid renderer
handles diagram fences and delegates all other Markdown inward. Third-party
assistant renderers can replace the chain only through an explicit
`{ override: true }` registration.

`PSS_MERMAID=0` disables diagram rendering (fences show as plain code blocks).
