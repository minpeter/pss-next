## @minpeter/pss-extension-latex@0.0.1-next.2 (next)

### Declare the coding agent dependency in extensions

Add @minpeter/pss-coding-agent as a dev dependency of the LaTeX, Mermaid, and web extensions so Turborepo 2.10.8 boundaries accepts the /extension imports.

### Update the pi-tui renderer dependency

Bump @earendil-works/pi-tui from 0.82.1 to 0.83.0 in the coding agent and the LaTeX and Mermaid extensions.

## @minpeter/pss-extension-latex@0.0.1-next.1 (next)

### Increase the default LaTeX display size

Render display formulas at a more readable terminal size while preserving high-resolution source images and user scale overrides.

## @minpeter/pss-extension-latex@0.0.1-next.0 (next)

### Render LaTeX display math through an overridable extension

Assistant `$$ ... $$` and `\[ ... \]` display blocks now render through
LaTeX, DVI, `dvipng`, and ImageMagick into cached transparent PNGs in
Kitty-graphics terminals. The renderer preserves incomplete or invalid source
as Markdown, repairs common single-backslash row terminators, keeps
high-resolution source images at terminal-sized logical dimensions, and
deduplicates missing-dependency notices for the lifetime of the TUI session.
Formula scale and terminal-specific horizontal correction are configurable
with `PSS_LATEX_SCALE` and `PSS_LATEX_ASPECT`.

The implementation ships as the independently versioned
`@minpeter/pss-extension-latex` package, which coding-agent includes by
default. The assistant-renderer capability now exposes lifecycle cancellation,
disposal, redraw, notification, ownership, conflict, and reload boundaries.
Official LaTeX registers as a fallback; third-party renderers must explicitly
opt into replacing it, and removing an override restores the official
renderer.

Native rendering uses an allowlisted environment, bounded queue and cache
reads, process-tree cancellation, PNG dimension limits, disabled
Ghostscript/raw-PostScript paths, and per-stage time and output limits. It runs
only on Linux with Bubblewrap namespace/filesystem isolation and `prlimit`
resource bounds available; otherwise the original Markdown remains visible.
