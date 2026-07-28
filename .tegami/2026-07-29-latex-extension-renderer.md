---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Render LaTeX display math through an overridable extension

Assistant `$$ ... $$` and `\[ ... \]` display blocks now render through
LaTeX, DVI, `dvipng`, and ImageMagick into cached transparent PNGs in
Kitty-graphics terminals. The renderer preserves incomplete or invalid source
as Markdown, repairs common single-backslash row terminators, keeps
high-resolution source images at terminal-sized logical dimensions, and
deduplicates missing-dependency notices for the lifetime of the TUI session.
Formula scale and terminal-specific horizontal correction are configurable
with `PSS_LATEX_SCALE` and `PSS_LATEX_ASPECT`.

The implementation ships as the bundled
`@minpeter/pss-coding-agent/latex` extension and as a dedicated package
subpath. The assistant-renderer capability now exposes lifecycle cancellation,
disposal, redraw, notification, ownership, conflict, and reload boundaries.
Bundled LaTeX registers as a fallback; third-party renderers must explicitly
opt into replacing it, and removing an override restores the bundled renderer.

Native rendering uses an allowlisted environment, bounded queue and cache
reads, process-tree cancellation, PNG dimension limits, disabled
Ghostscript/raw-PostScript paths, and per-stage time and output limits. It runs
only on Linux with Bubblewrap namespace/filesystem isolation and `prlimit`
resource bounds available; otherwise the original Markdown remains visible.
