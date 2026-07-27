---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Add hashline edit diffs to the coding-agent TUI

The coding agent now renders anchored `edit_file` results as sorted,
senpi-style word diffs with faint changed regions, stronger intra-token
highlights, and dim context rows for unchanged lines.

The TUI modules are organized by code flow under `src/tui/`, and read/diff
rendering now displays terminal control characters as safe visible
placeholders instead of forwarding them to the terminal.
